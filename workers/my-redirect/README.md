# my-redirect worker

`my.parachute.computer/*` → **302** `https://app.parachute.computer/*` (path + query preserved).

Name-claim placeholder for the ratified one-origin consolidation — Aaron ratified
`my.parachute.computer` as Cloud's future canonical origin (browser → surface,
AI connectors → `my.parachute.computer/vault/<name>/mcp`, `u.` staying a
permanent alias) in `Parachute/Decisions/2026-07-16 One canonical URL —
my.parachute.computer` in the team vault. Today's step only claims the
hostname; this worker is a stopgap, not the design.

**302, not 301**: the redirect target is temporary. **Phase A** (queued next
window) replaces this worker entirely with the real `my.` topology — a
Custom Domain on the identity worker plus a `my./vault/*` zone route on the
vault worker (a zone route on the same hostname takes precedence over a
Custom Domain, so `/vault/*` traffic reaches the vault worker directly while
everything else falls to identity) — so no client should cache this
redirect as permanent in the meantime.

**Requires `my.parachute.computer` to be a PROXIED (orange-cloud) DNS
record** — a worker route only intercepts proxied hostnames. DNS is Aaron's
to add; this worker no-ops until that record exists.

Deploy: `cd workers/my-redirect && CLOUDFLARE_ACCOUNT_ID=d5d7c8646c3b69ce9f16bfd12ecbe98a bunx wrangler deploy`
(the `my.parachute.computer/*` route is declared in wrangler.toml and applied on deploy).
Verify: `curl -sI https://my.parachute.computer/vault/demo` → `302` + `location: https://app.parachute.computer/vault/demo`.
