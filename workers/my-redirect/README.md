# my-redirect worker — SUPERSEDED (delete at Phase A activation)

`my.parachute.computer/*` → **302** `https://app.parachute.computer/*` (path + query preserved).

> **STATUS: Phase A is BUILT — this worker is now a stopgap awaiting retirement.**
> The real `my.` topology has fully landed in config: `my.` is a Custom Domain on
> the **identity** worker (browser → SPA shell + the cookie-authed ceremonies,
> #163) and a set of **zone routes** on the **vault** worker for `my./vault/*`,
> the two RFC discovery `.well-known` forms (#163), and — as of this PR — the U1
> canonical root `my./mcp*` + its root PRM (`#192` shipped the handler and left
> `my.` unrouted; this PR routes it). A zone route beats a Custom Domain on the
> same hostname, so the data plane reaches the vault worker directly while every
> other path (the SPA shell, ceremonies) falls to identity. This 302 worker is
> **no longer the design** — it exists only until the cutover deletes its route.

Name-claim placeholder for the ratified one-origin consolidation — Aaron ratified
`my.parachute.computer` as Cloud's canonical origin (browser → surface, AI
connectors → the canonical root `my.parachute.computer/mcp` **and** the
URL-addressed `my.parachute.computer/vault/<name>/mcp`, `u.` staying a permanent
alias) in `Parachute/Decisions/2026-07-16 One canonical URL — my.parachute.computer`
in the team vault.

**302, not 301** (deliberate): the redirect was always meant to be temporary, so
no client cached it as permanent while Phase A was in flight. That is now cashed
in — the real topology is here.

## Activation runbook (delete this worker + its route)

This PR builds config only; it deploys nothing and deletes nothing (reviewer-gated,
and DNS + the prod deploy are Aaron's). At activation, in order:

1. **Merge + prod-deploy the two real workers** — Aaron approves the `production`
   environment run of `deploy-prod.yml` (or `bash scripts/deploy-prod.sh`) so the
   vault worker's `my./vault/*` + `my./mcp*` + root-discovery zone routes and the
   identity worker's `my.` Custom Domain both attach. The zone routes must attach
   **before** the my. Custom Domain starts serving real traffic (they win the
   precedence, so their attach order relative to the redirect worker is what
   matters — see step 2).
2. **Delete the my-redirect worker's route, then the worker:**
   ```sh
   cd workers/my-redirect
   # remove the my.parachute.computer/* route this worker holds
   CLOUDFLARE_ACCOUNT_ID=d5d7c8646c3b69ce9f16bfd12ecbe98a bunx wrangler delete
   ```
   (`wrangler delete` removes the worker and its routes together. The vault
   worker's zone routes already out-prioritize a Custom Domain on the same host,
   but this redirect worker holds a broad `my.parachute.computer/*` route — delete
   it so it can never intercept ahead of the real topology.)
3. **Live-verify the real `my.` topology** (all against production):
   ```sh
   # root serves the SPA shell (identity Custom Domain, Host-branch)
   curl -sI https://my.parachute.computer/ | grep -i 'content-type'      # → text/html
   # /vault/<name> reaches the VAULT worker (zone route), not a 302 or the SPA
   curl -s  https://my.parachute.computer/vault/demo/health               # → {"status":"ok"} from the vault worker
   # the canonical root /mcp challenges with the ROOT PRM (U1), never a 200 SPA shell
   curl -sD - -o /dev/null -X POST https://my.parachute.computer/mcp \
     -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'                  # → 401 + WWW-Authenticate: …/oauth-protected-resource/mcp
   # the root PRM is served by the VAULT worker and names the my. root resource
   curl -s https://my.parachute.computer/.well-known/oauth-protected-resource/mcp  # → {"resource":"https://my.parachute.computer/mcp", …}
   # the BARE issuer PRM stays the IDENTITY worker's (no /mcp suffix → not zone-routed)
   curl -s https://my.parachute.computer/.well-known/oauth-protected-resource      # → the issuer PRM (identity worker)
   ```
   Any `content-type: text/html` on `/vault/…` or `/mcp` means a zone route did
   not attach — stop and fix before considering the cutover done.

Once verified, this directory can be removed from the repo.
