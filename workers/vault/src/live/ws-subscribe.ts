/**
 * Live-query WebSocket binding — the hibernatable transport for
 * `GET /vault/<name>/api/subscribe` with an `Upgrade: websocket` header
 * (WS-hibernation migration, 2026-07-04; decision
 * `Decisions/2026-07-04-live-query-ws-hibernation`, contract
 * `docs/live-query-ws.md`).
 *
 * This module is the PURE, DO-agnostic half: close codes, the versioned
 * per-socket attachment shape (what survives eviction), query validation
 * (same rejects as the SSE route), pending-attachment building + the
 * serialize-size guard, chunked-snapshot framing, first-message-auth parsing,
 * and the revocation tracker for the sweep. The DO integration (accept,
 * rehydrate, sweep, handlers) lives in `vault-do.ts` — it needs `this.ctx`.
 *
 * ## Why an attachment, not DO storage
 * A hibernated DO loses ALL in-memory state; only `serializeAttachment` (≤16 KB)
 * survives per socket. We store the RAW query string (not the parsed/expanded
 * matcher) so rehydration re-runs the SAME `parse + buildLiveMatcher` path the
 * live subscription was born from — one format, no drift. Single-DO-per-vault
 * makes write → wake → rehydrate(awaited) → apply-write → hook → dispatch clean
 * by construction.
 *
 * ## First-message auth (design fork 2, ratified)
 * Browsers can't set headers on a WebSocket and the hub ws-bridge drops
 * subprotocols, so auth is the FIRST socket message (`{"type":"auth","token"}`).
 * The socket is accepted pre-auth (bounded by the per-vault cap + a
 * pending-socket sweep) and no data flows until auth succeeds. Close codes are
 * visible to browser JS: 4400 protocol, 4401 unauthorized/expired/revoked,
 * 4403 scope, 4408 auth-timeout.
 */
import type { Note, QueryOpts } from "@openparachute/core/src/types.js";
import { defaultRevocationFetcher, REVOCATION_CACHE_TTL_MS } from "@openparachute/scope-guard";
import type { RevocationFetcher } from "@openparachute/scope-guard";
import { parseNotesQueryOpts } from "../rest/parse.js";
import { unsupportedSubscriptionReason } from "./live-match.js";

/** Per-vault concurrent WS-subscription cap (mirrors the SSE cap). Enforced at
 *  upgrade via `getWebSockets().length` — over it → 503. */
export const MAX_WS_SUBSCRIPTIONS = 100;

/** A pending (accepted-but-unauthed) socket must send `{type:"auth"}` within
 *  this window; the sweep closes stragglers (4408). No standing timer — a timer
 *  would pin the DO awake and defeat hibernation. */
export const WS_AUTH_DEADLINE_MS = 10_000;

/** Attachment schema version — bumped on any breaking shape change; a mismatch
 *  on rehydration closes the socket (4400) rather than mis-parsing stale state. */
export const WS_ATTACHMENT_VERSION = 1 as const;

/** Serialized-attachment size guard. Under workerd's 16,384-byte
 *  `serializeAttachment` hard limit, with headroom for the auth fields added at
 *  ready-time (all small — the dominant term is the raw query string `q`). */
export const MAX_ATTACHMENT_BYTES = 15_000;

/** Conservative per-frame byte budget for chunked snapshots — well under the
 *  ~1 MiB edge WebSocket message ceiling (verified on staging with a large
 *  fixture). A single note larger than this still ships as its own one-note
 *  chunk (documented residual — note bodies are markdown, ~never >1 MiB). */
export const SNAPSHOT_CHUNK_BYTES = 512 * 1024;

/** Secondary snapshot-chunk bound (note count) so many tiny notes still split. */
export const SNAPSHOT_CHUNK_MAX_NOTES = 200;

/** Application close codes (3000–4999 app-defined range), surfaced to browser JS
 *  so surface-client can branch (Phase 2). */
export const WS_CLOSE = {
  /** Malformed frame / protocol violation / unparseable rehydration. */
  PROTOCOL: 4400,
  /** Auth failed, token expired, or revoked. */
  UNAUTHORIZED: 4401,
  /** Scope mismatch, or a re-auth that would WIDEN scope. */
  FORBIDDEN: 4403,
  /** Accepted socket never authed within {@link WS_AUTH_DEADLINE_MS}. */
  AUTH_TIMEOUT: 4408,
} as const;

/**
 * Per-socket state that survives hibernation/eviction (`serializeAttachment`).
 * Versioned; store the RAW query string, never the parsed matcher.
 */
export interface WsAttachment {
  v: typeof WS_ATTACHMENT_VERSION;
  state: "pending" | "ready";
  /** RAW query string incl. leading `?` (e.g. `?tag=watch`). Rehydration and
   *  auth-time both reconstruct a URL from it and re-run parse+buildMatcher. */
  q: string;
  /** Granted scopes for the vault (ready only) — the re-auth narrow check. */
  scopeRaw: string[] | null;
  /** JWT `exp` (epoch SECONDS) or null (operator bearer / no exp). */
  exp: number | null;
  /** JWT `jti` or null — the sweep's revocation check. */
  jti: string | null;
  actor: string | null;
  via: string | null;
  clientId: string | null;
  /** epoch ms the socket was accepted (the pending-auth deadline base). */
  connectedAt: number;
  /** Opaque per-socket id (logging / debugging). */
  subId: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Validate a subscribe query for the WS path — the SAME rejects as the SSE
 * route (`subscribe.ts`): `search` / `near` / `cursor` / `has_links` / date
 * filters can't be evaluated against a single changed note. The 400 bodies +
 * `UNSUPPORTED_SUBSCRIPTION_QUERY` code are byte-identical to the SSE route
 * (pinned by the ws-subscribe parity test) so both doors agree. Returns a ready
 * 400 Response on rejection, else the parsed `QueryOpts`.
 */
export function validateWsSubscribeQuery(url: URL): { error: Response } | { queryOpts: QueryOpts } {
  if (url.searchParams.get("search")) {
    return {
      error: json(
        {
          error:
            "search (full-text) is not supported for live subscriptions — FTS can't be evaluated against a single changed note. Drop `search` or poll GET /notes?search=.",
          code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
        },
        400,
      ),
    };
  }
  if (url.searchParams.get("near[note_id]")) {
    return {
      error: json(
        {
          error:
            "near (graph neighborhood) is not supported for live subscriptions — BFS can't be evaluated against a single changed note. Drop `near` or poll GET /notes?near[note_id]=.",
          code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
        },
        400,
      ),
    };
  }

  const parsed = parseNotesQueryOpts(url);
  if (parsed.error) return { error: parsed.error };
  const queryOpts = parsed.queryOpts!;

  const unsupported = unsupportedSubscriptionReason(queryOpts);
  if (unsupported) {
    return { error: json({ error: unsupported, code: "UNSUPPORTED_SUBSCRIPTION_QUERY" }, 400) };
  }
  return { queryOpts };
}

/** 503 body for the per-vault WS-subscription cap (mirrors the SSE 503). */
export function subscriptionCapResponse(): Response {
  return json(
    {
      error:
        "subscription cap reached for this vault — too many concurrent live subscriptions. Retry shortly or close idle streams.",
      code: "SUBSCRIPTION_CAP_REACHED",
    },
    503,
  );
}

/** Reconstruct a URL carrying `q` (the raw stored query string) so the shared
 *  parser can run. Host/path are irrelevant — only `searchParams` is read. */
export function urlFromQuery(q: string): URL {
  const u = new URL("https://ws.local/vault/_/api/subscribe");
  u.search = q ?? "";
  return u;
}

/** Build the initial PENDING attachment from the raw query string, guarding the
 *  serialized size. `tooLarge` → the upgrade is refused with 400. */
export function buildPendingAttachment(rawQuery: string): { attachment: WsAttachment } | { tooLarge: true } {
  const attachment: WsAttachment = {
    v: WS_ATTACHMENT_VERSION,
    state: "pending",
    q: rawQuery,
    scopeRaw: null,
    exp: null,
    jti: null,
    actor: null,
    via: null,
    clientId: null,
    connectedAt: Date.now(),
    subId: crypto.randomUUID(),
  };
  if (attachmentBytes(attachment) > MAX_ATTACHMENT_BYTES) return { tooLarge: true };
  return { attachment };
}

/** Serialized byte length of an attachment (the `serializeAttachment` payload). */
export function attachmentBytes(att: WsAttachment): number {
  return new TextEncoder().encode(JSON.stringify(att)).byteLength;
}

/**
 * Parse + version-check a deserialized attachment. Returns null when it's
 * absent, the wrong shape, or a version mismatch — the caller closes 4400
 * (never mis-parse stale state into a live subscription).
 */
export function parseAttachment(raw: unknown): WsAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (a.v !== WS_ATTACHMENT_VERSION) return null;
  if (a.state !== "pending" && a.state !== "ready") return null;
  if (typeof a.q !== "string") return null;
  if (typeof a.connectedAt !== "number") return null;
  return a as unknown as WsAttachment;
}

/**
 * Frame a snapshot into one or more `{type:"snapshot", notes, done}` messages,
 * each under the WS message ceiling. ALWAYS emits at least one frame (an empty
 * set → a single `done:true` frame) so the client's snapshot handler fires
 * exactly once per (re)connect. The consumer concatenates `notes` across frames
 * until `done:true`.
 */
export function buildSnapshotFrames(notes: Note[]): string[] {
  const frames: string[] = [];
  const enc = new TextEncoder();
  let batch: Note[] = [];
  let batchBytes = 0;
  for (const note of notes) {
    const noteBytes = enc.encode(JSON.stringify(note)).byteLength + 1; // +1 ~ comma
    if (batch.length > 0 && (batchBytes + noteBytes > SNAPSHOT_CHUNK_BYTES || batch.length >= SNAPSHOT_CHUNK_MAX_NOTES)) {
      frames.push(JSON.stringify({ type: "snapshot", notes: batch, done: false }));
      batch = [];
      batchBytes = 0;
    }
    batch.push(note);
    batchBytes += noteBytes;
  }
  frames.push(JSON.stringify({ type: "snapshot", notes: batch, done: true }));
  return frames;
}

/** A parsed client message (auth / re-auth / other). */
export type ParsedClientMessage =
  | { kind: "auth"; token: string }
  | { kind: "other"; type: string | undefined }
  | { kind: "malformed" };

/** Parse a client WS message. Only JSON objects reach here — the literal `ping`
 *  keepalive is answered by `setWebSocketAutoResponse` WITHOUT waking the DO. */
export function parseClientMessage(message: string | ArrayBuffer): ParsedClientMessage {
  let text: string;
  if (typeof message === "string") text = message;
  else {
    try {
      text = new TextDecoder().decode(message);
    } catch {
      return { kind: "malformed" };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "auth") {
    if (typeof obj.token !== "string" || obj.token.length === 0) return { kind: "malformed" };
    return { kind: "auth", token: obj.token };
  }
  return { kind: "other", type: typeof obj.type === "string" ? obj.type : undefined };
}

/**
 * Best-effort revocation tracker for the sweep — reuses scope-guard's revocation
 * wire (`<origin>/.well-known/parachute-revocation.json`) + its 60s TTL, with a
 * per-origin single-flight cache. Posture DIFFERS from auth-time on purpose: an
 * already-authed socket passed full validation (incl. fail-closed revocation) at
 * auth time, so here we close ONLY on a CONFIRMED revocation (a good list that
 * contains the jti). A revocation-list outage leaves the socket open until its
 * `exp` (the exp-sweep's bound), rather than mass-closing live sockets on a
 * transient hub blip — fail-OPEN for already-authed connections.
 */
export class RevocationTracker {
  private cache = new Map<string, { jtis: Set<string>; fetchedAt: number; good: boolean }>();
  private inFlight = new Map<string, Promise<void>>();
  constructor(
    private readonly fetcher: RevocationFetcher = defaultRevocationFetcher,
    private readonly ttlMs: number = REVOCATION_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private async refresh(origin: string): Promise<void> {
    let flight = this.inFlight.get(origin);
    if (flight) return flight;
    flight = (async () => {
      try {
        const body = await this.fetcher(origin);
        this.cache.set(origin, { jtis: new Set(body.jtis ?? []), fetchedAt: this.now(), good: true });
      } catch {
        const prev = this.cache.get(origin);
        if (prev) prev.fetchedAt = this.now(); // keep last-good; retry next TTL
        else this.cache.set(origin, { jtis: new Set(), fetchedAt: this.now(), good: false });
      } finally {
        this.inFlight.delete(origin);
      }
    })();
    this.inFlight.set(origin, flight);
    return flight;
  }

  /** True only when a CONFIRMED-good revocation list contains `jti`. */
  async isRevoked(origin: string, jti: string): Promise<boolean> {
    const st = this.cache.get(origin);
    if (!st || this.now() - st.fetchedAt > this.ttlMs) await this.refresh(origin);
    const cur = this.cache.get(origin);
    return !!cur && cur.good && cur.jtis.has(jti);
  }
}
