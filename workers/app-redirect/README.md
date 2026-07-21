# app-redirect worker

`app.parachute.computer/*` → **301** `https://my.parachute.computer/*` (path + query preserved).

my.-canonical Phase 1: `my.parachute.computer` is the one advertised human origin. `app.`
remains a co-equal SPA Custom Domain on the identity worker, but a **Custom Domain only
route-matches `/` at the worker** — every deep SPA path (`/n/…`, `/settings`, `/tags`, the
`/oauth/callback` PKCE return) is served by the Static-Assets runtime and never reaches the
worker. So an in-worker `/`-only redirect would leave deep `app.` links serving the stale
origin. A **zone route** (`app.parachute.computer/*`) on this tiny worker takes precedence
over that Custom Domain (CF ["Interaction with Routes"](https://developers.cloudflare.com/workers/configuration/routing/routes/#interaction-with-custom-domains))
and intercepts **every** `app.` request — root and deep — at the platform layer, 301'ing it
to the same path on `my.`.

**The token issuer is UNCHANGED** — this is an advertised-origin move, not an issuer flip
(`iss` / JWKS / OAuth discovery `issuer` / `aud` all stay `cloud.` through the later phases).

The identity worker keeps `app.parachute.computer` declared as a Custom Domain
(`test-bun/my-topology-routes.test.ts` pins that); this route simply shadows it.

**Requires `app.parachute.computer` to be a PROXIED (orange-cloud) DNS record** — a worker
route only intercepts proxied hostnames.

Deploy: `cd workers/app-redirect && CLOUDFLARE_ACCOUNT_ID=d5d7c8646c3b69ce9f16bfd12ecbe98a bunx wrangler deploy`
(the `app.parachute.computer/*` route is declared in wrangler.toml and applied on deploy).
Verify: `curl -sI https://app.parachute.computer/n/x` → `301` + `location: https://my.parachute.computer/n/x`.

**Deploy ordering (Phase 1 cutover):** deploy this worker (and re-point notes-redirect) as
part of the same change that flips `APP_ORIGIN` to `my.` — and TIME it with the announcement
email (existing `app.`-origin sessions do a one-time reconnect on `my.`).
