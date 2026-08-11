# Parachute Cloud

`@openparachute/cloud` — the **Vault Cloud**: Parachute's hosted door ("pay us money, get a vault") on Cloudflare Workers/D1/DO/R2. **One Durable Object per vault**: the DO's SQLite *is* the vault (`@openparachute/core` behind a `Database`-shaped shim); DO isolation is the tenant boundary; scale-to-zero — hibernated vaults bill ~storage only. Design of record: `parachute.computer/design/2026-07-02-vault-cloud-serverless-design.md`.

> Git history pre-2026-07 describes a DISCARDED architecture (Fly Machines per user, killed 2026-07-02). Don't take direction from it.

## Layout

- `workers/vault/` — the Vault DO + edge router: REST wire contract, MCP endpoint, SSE live queries, R2 attachments + export. Conformance suite runs under real workerd (`@cloudflare/vitest-pool-workers`).
- `workers/identity/` — OAuth issuer (hub-contract-exact) + self-serve console + `/account/*` API + ops crons + Stripe billing + operator admin. The feature list lives in the git/PR history + the `src/` filenames — read those, it is not restated here.
- `src/` — the OLD control plane. Dormant; harvest material only.
- `scripts/` — deploy + smoke: `deploy-staging.sh`/`smoke-staging.ts` (full live smoke, creates test debris) for staging; `deploy-prod.sh`/`smoke-prod.ts` (read-only checks) for production. Deploys also build + embed the app SPA from the commit pinned in `scripts/spa-source.env` — promote the app by bumping the pin.

## Commands

```sh
bun install                         # ALSO refreshes the copied core dep (see gotcha)
bun run test                        # control-plane tests (src/) + round-trip tests (test-bun/)
bun run typecheck                   # root tsc
cd workers/vault && bun run typecheck && bun x vitest run     # conformance under workerd
cd workers/identity && bun run typecheck && bun x vitest run
bash scripts/deploy-staging.sh      # deploy both workers -e staging + migrate + seed
bun scripts/smoke-staging.ts        # FULL live smoke vs staging (creates test debris)
bash scripts/deploy-prod.sh         # deploy both workers top-level + migrate (NO seed)
bun scripts/smoke-prod.ts           # READ-ONLY live checks vs production
```

## Load-bearing gotchas

- **Stale `file:` core dep** — `workers/vault` depends on `@openparachute/core` via `file:../../../parachute-vault/core`; bun COPIES it at install. After any vault-core change, `bun install` or you test/deploy stale core (the deploy scripts do it; test runs don't).
- **DO SQLite rejects `BEGIN/COMMIT`** — core's `transaction()` duck-types the shim's `transactionSync`.
- **workerd ≠ vitest-workerd** — e.g. runtime caps PBKDF2 at 100k iterations, the test pool doesn't enforce it (green tests, every live login 500'd). ALWAYS live-smoke after deploy.
- **`wrangler deploy` success ≠ globally propagated** — an edge PoP can serve the old version minutes later. `/health`'s `version` field is per-PoP ground truth; `deploy-staging.sh` polls it against a pre-deploy baseline before smoking.
- **`TEST_JWKS`** is double-gated on `ENVIRONMENT="test"` — never set that in a deployed config.
- **`[observability]` is NOT inherited by named envs** — needed in BOTH scopes of both wrangler.tomls (top-level AND `[env.staging.observability]`).
- **PRODUCTION = the TOP-LEVEL wrangler config, and can NEVER move into an `[env.production]`.** Named envs re-suffix worker names; a renamed worker detaches the Custom Domains (`cloud.` / `u.parachute.computer`) and orphans every existing vault DO. Staging is `[env.staging]` (`wrangler deploy -e staging`, workers.dev origins only).
- **Staging's `routes = []` override is load-bearing** — without it staging inherits prod's custom-domain route.
- **The first-party `client_id` (`parachute-console`) is the vault-side platform-vs-tenant gate** (`workers/vault/src/auth.ts` `FIRST_PARTY_CLIENT_ID`) — scope/verb alone can't distinguish, because a vault owner can mint `vault:<name>:admin` via public OAuth.
- **`__test/*` + mock-billing endpoints must 404 in production** — smoke-prod-pinned; keep them pinned.
- **Stripe dep pinned EXACT** (`22.1.0`) — caret drift broke types on fresh installs (bun.lock committed since #104; the exact pin is defense-in-depth).
- **Snapshots carry NO attachment binaries** — say it everywhere user-facing; on-demand `/api/export` DOES stream them.
- **Raw transcript is sacred** — the cleaned note body is a derived view; the raw is always preserved on note + attachment metadata.
- **SPA CSP lives in `workers/identity/src/spa-csp.ts`**, shipped through TWO surfaces that must not drift: the generated `dist-assets/_headers` (`scripts/gen-spa-headers.ts`) + the worker's `/` Host-branch.
- **`BOUND_ORIGINS`** (prod `[vars]`) must include every non-issuer serving origin (`app.`, `my.`) or every cookie-authed POST from those origins 401s as "session expired".
- Longer canonical notes live in code, not here: KDF posture → `workers/identity/src/users.ts`; CORS split → `workers/identity/src/oauth-shared.ts`.

## Critical rule: shared core + shared wire contract, forked runtime

The engine is `@openparachute/core` (in parachute-vault) — never reimplement schema/query/MCP-tool semantics here; PR core changes upstream. The WIRE contract (REST shapes, OAuth flows, MCP discovery, portable-md bytes) must match the bun vault byte-shaped. The RUNTIME (router/DO/R2/D1) diverges by design. Extend the conformance suites with every endpoint you add.

## Governance / CI

Same as the workspace: PR-only, reviewer-gated, no self-merge; every code-touching PR bumps rc.N (private package — the discipline is for history legibility). `.github/workflows/ci.yml` and both deploy paths materialize the exact parachute-vault commit pinned in `scripts/vault-source.env` as a sibling (the `file:` core dep needs it) — promote vault-core by bumping the pin. `deploy-staging.yml` auto-runs on pushes to main; `deploy-prod.yml` is manual-dispatch only, gated on Aaron's `production` environment approval. The deploy secret-gate skips GREEN when secrets are unset — verify a NEW deployment actually landed before claiming deployed.

## License

AGPL-3.0.
