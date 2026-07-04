# Live-query WebSocket binding

Status: **Phase 1 (cloud binding + hibernation)** — shipped behind the
additive rollout. Decision: `Decisions/2026-07-04-live-query-ws-hibernation`
(team vault). Plan: `Work/ws-hibernation-migration`.

The live-query subscription contract has **one shape, two transports**: the
existing **SSE** binding and this **WebSocket** binding. Same URL
(`GET /vault/<name>/api/subscribe?<query>`); an `Upgrade: websocket` request
header selects WS, everything else stays SSE. The SSE handler is **untouched**
and remains the fallback (deprecation = "not default", then eventual removal —
never a break for a live client).

**Why WS at all** — an open SSE stream pins the per-vault Durable Object awake and
bills duration (~$4/mo per always-open tab). Cloudflare **Hibernatable
WebSockets** let an idle-but-open socket evict the DO → ~$0 idle, while a write
transparently wakes it to push. On the wire the two transports are
indistinguishable bar the framing; hibernation is a cloud-internal detail. The
self-host (bun) door speaks the same WS contract minus hibernation (a self-run
box has no per-connection duration bill).

## Wire payload parity (the load-bearing invariant)

**The WS payload bytes are identical to the SSE `data:` bodies.** Concretely:
for `upsert` and `remove`, the inner payload (`{ "note": … }` / `{ "id": … }`)
serializes **byte-for-byte identically** across both transports. The only
structural difference is that a WebSocket message has no separate event-name
frame, so the SSE `event:` name folds into a `type` discriminator:

| Event | SSE frame | WS message |
|-------|-----------|------------|
| upsert | `event: upsert\ndata: {"note":{…}}\n\n` | `{"type":"upsert","note":{…}}` |
| remove | `event: remove\ndata: {"id":"…"}\n\n` | `{"type":"remove","id":"…"}` |
| snapshot | `event: snapshot\ndata: {"notes":[…]}\n\n` | `{"type":"snapshot","notes":[…],"done":true}` (chunked) |

i.e. the WS message is `{ type: <event>, ...<sse data body> }`. Both transports
format through one place each (`sseFrame` / `wsFrame` in `live/subscriptions.ts`)
and are pinned against the **shared frame-corpus fixture**
(`test/fixtures/live-frame-corpus.ts`) by both the SSE and WS parity tests —
neither transport may reorder or mutate the payload; the `type` fold (and the
snapshot `done` flag) is the whole of the difference.

## Server → client messages

- **`{"type":"snapshot","notes":[…],"done":<bool>}`** — the complete matching set
  at (re)connect, **chunked** to stay under the edge WS message ceiling (~1 MiB).
  Emit order: zero or more `done:false` frames, then exactly one `done:true`
  frame (an empty set → a single `done:true` frame). The client concatenates
  `notes` across frames until `done:true`, then **replaces** its set (the SSE
  self-correcting-reconnect semantics). A snapshot is sent once per authenticated
  (re)connect — **never** on rehydration after an eviction.
- **`{"type":"upsert","note":{…}}`** — a note entered the set or an in-set note
  changed.
- **`{"type":"remove","id":"…"}`** — a note left the set (update-no-longer-matches)
  or was deleted. Idempotent; ignore ids you don't hold.

## Client → server messages

- **`{"type":"auth","token":"<jwt|bearer>"}`** — **first message**, required
  within ~10s of connect. Also re-sent on token refresh (re-auth) on the open
  socket; re-auth updates the token's expiry window with **no re-snapshot**.
- **`ping`** — the literal string `ping` (not JSON) is answered with `pong` by the
  runtime's `WebSocketRequestResponsePair` auto-response, **without waking the
  DO** (this is the "pennies" — client-driven liveness, no server keepalive
  timer). Replaces both the 25s SSE keepalive comment and the 15-min SSE lifetime
  cap (which existed only to bound duration — gone for WS).

### Auth handshake (first-message, not header)

Browsers cannot set request headers on a WebSocket, and the hub ws-bridge drops
subprotocols, so auth is a message rather than a header/`?key=` (a `?key=` leaks
the token into proxy logs). The socket is **accepted pre-auth** and no data flows
until auth succeeds — bounded by the per-vault cap (100) and the pending-socket
sweep. A ticket-endpoint is a contract-compatible retrofit if abuse appears.

- Success → the socket flips to `ready`; the snapshot is sent.
- Failure → the socket is closed with a code below.
- **Re-auth** may only **narrow-or-equal** the granted vault verb; a widen → 4403.

## Close codes (application range 3000–4999, visible to browser JS)

| Code | Meaning |
|------|---------|
| **4400** | Protocol error — malformed message, non-auth first message, or an unparseable / version-mismatched attachment on rehydration. |
| **4401** | Unauthorized — auth failed, or (on the sweep) the token **expired** or was **revoked**. |
| **4403** | Forbidden — token `vault_scope` mismatch, or a re-auth that would **widen** scope. |
| **4408** | Auth timeout — accepted socket never authed within ~10s (enforced by the sweep, no standing timer). |

## Hibernation model (cloud only)

- **Accept** with `ctx.acceptWebSocket(server)` and a **versioned attachment**
  (`serializeAttachment`, ≤16 KB) carrying the **raw query string** plus (after
  auth) `exp` / `jti` / scope / actor. Storing the raw query — not the parsed
  matcher — means rehydration re-runs the exact `parse + buildLiveMatcher` path
  the subscription was born from (one format, no drift). Over ~15 KB serialized →
  the upgrade is refused 400 (`SUBSCRIPTION_QUERY_TOO_LARGE`).
- **Rehydration** (`ensureSubscriptionsRehydrated`, once per warm DO, guarded) —
  a hibernated DO loses all in-memory state; `ctx.getWebSockets()` keeps the
  sockets + attachments. On the next wake we rebuild the matcher + sink and
  re-register with the manager, **without** re-sending a snapshot. Called at the
  top of **every** wake entry point: `fetch`, `webSocketMessage`,
  `webSocketClose`, `webSocketError`, `alarm`. **Single-DO-per-vault** makes
  `write → wake → rehydrate(awaited) → apply-write → post-commit hook → dispatch`
  correct by construction — no missed event, no spurious snapshot.
- **Sweep-before-dispatch** (`sweepWsSockets`) — on every wake, before a write
  fans out, close sockets whose `exp` has passed (4401) or whose `jti` is
  confirmed revoked (4401, best-effort, fail-open for an already-authed socket on
  a revocation-list outage), and pending sockets past the auth deadline (4408).
  **No standing timers/alarms** — they would pin the DO awake and defeat
  hibernation (and the DO's one alarm slot is the transcription pipeline's). A
  scheduled far-future transcription alarm does **not** keep an idle-WS vault
  awake; hibernation still evicts, and the alarm re-wakes the DO only when due.

## Caps & limits

- **100** concurrent subscriptions per vault, counted at upgrade over the LIVE
  sockets (`getWebSockets()` filtered to readyState CONNECTING/OPEN) → over →
  **503** `SUBSCRIPTION_CAP_REACHED`. **Pending (accepted-but-unauthed) sockets
  count toward the cap** — a socket that only ever pings (auto-response, never
  wakes the DO) would otherwise sit forever. This **self-heals**: every upgrade
  runs `sweepWsSockets` (which closes pending sockets past the ~10s auth
  deadline, 4408) BEFORE the cap check, and a just-closed socket is CLOSING
  (readyState 2), so it no longer counts — freeing the slot for the new
  connection on the same wake. (Counting raw `getWebSockets().length` would keep
  the cap "full" of the sockets the sweep just closed; the live-only count is
  what makes the self-heal immediate.)
- Attachment ≤ **~15 KB** serialized (under workerd's 16,384-byte hard limit).
- Snapshot chunk budget **512 KB** / **200 notes** per frame (conservative under
  the ~1 MiB WS message ceiling — the real ceiling is verified on staging with a
  large fixture). A single note larger than the budget ships as its own one-note
  chunk (documented residual; note bodies are markdown, ~never > 1 MiB).

## Rejected query shapes (same as SSE)

`search` (FTS), `near` (graph BFS), `cursor` (paging), `has_links`, and date
filters can't be evaluated against a single changed note → **400**
`UNSUPPORTED_SUBSCRIPTION_QUERY`, byte-identical body to the SSE route.
