# notes-redirect worker

`notes.parachute.computer/*` → **301** `https://app.parachute.computer/*` (path + query preserved).

The legacy Notes host (`notes.parachute.computer`) was a pre-app-cutover GitHub Pages
deploy — it served a stale shell at `/` but 404'd on `/oauth/callback` and every deep
link, so old bookmarks/PWAs/email-links silently dead-ended. This tiny worker bounces
every such request onto the live app.

**Requires `notes.parachute.computer` to be a PROXIED (orange-cloud) DNS record** — a
worker route only intercepts proxied hostnames. Flipped to proxied 2026-07-12.

Deploy: `cd workers/notes-redirect && CLOUDFLARE_ACCOUNT_ID=d5d7c8646c3b69ce9f16bfd12ecbe98a bunx wrangler deploy`
(the `notes.parachute.computer/*` route is declared in wrangler.toml and applied on deploy).
Verify: `curl -sI https://notes.parachute.computer/n/x` → `301` + `location: https://app.parachute.computer/n/x`.
