# Parachute Cloud

`@openparachute/cloud` — the **Vault Cloud**: Parachute's hosted door ("pay us money, get a vault") on Cloudflare Workers/D1/DO/R2. **One Durable Object per vault**: the DO's SQLite *is* the vault (`@openparachute/core` behind a `Database`-shaped shim); DO isolation is the tenant boundary; scale-to-zero — hibernated vaults bill ~storage only. Design of record: `parachute.computer/design/2026-07-02-vault-cloud-serverless-design.md`.

> Git history pre-2026-07 describes a DISCARDED architecture (Fly Machines per user, killed 2026-07-02). Don't take direction from it.

## Layout

- `workers/vault/` — the Vault DO + edge router: REST wire contract, MCP endpoint, SSE live queries, R2 attachments + export. Conformance suite runs under real workerd (`@cloudflare/vitest-pool-workers`).
- `workers/identity/` — OAuth issuer (hub-contract-exact) + self-serve console + `/account/*` API + ops crons + Stripe billing + operator admin. The feature list lives in the git/PR history + the `src/` filenames — read those, it is not restated here.
- `src/` — the OLD control plane. Dormant; harvest material only.
- `scripts/` — deploy + smoke: `deploy-staging.sh`/`smoke-staging.ts` (full live smoke, creates test debris) for staging (its own account; `scripts/staging-account.env` + `scripts/staging-bootstrap.sh`); `deploy-prod.sh`/`smoke-prod.ts` (read-only checks) for production. Deploys also build + embed the app SPA from the commit pinned in `scripts/spa-source.env` — promote the app by bumping the pin.

## Commands

```sh
bun install                         # ALSO refreshes the copied core dep (see gotcha)
bun run test                        # control-plane tests (src/) + round-trip tests (test-bun/)
bun run typecheck                   # root tsc
cd workers/vault && bun run typecheck && bun x vitest run     # conformance under workerd
cd workers/identity && bun run typecheck && bun x vitest run
bash scripts/door-parity.sh         # the door contracts a box runs (parachute-core, pinned), against both workers under local workerd, compared with the box
bash scripts/staging-bootstrap.sh --local DIR   # rehearse a fresh staging account (miniflare; no Cloudflare call)
bash scripts/deploy-staging.sh      # deploy both workers -e staging + migrate + seed
bun scripts/smoke-staging.ts        # FULL live smoke vs staging (creates test debris)
bash scripts/deploy-prod.sh         # deploy both workers top-level + migrate (NO seed)
bun scripts/smoke-prod.ts           # READ-ONLY live checks vs production
bun scripts/smoke-health-staging.ts # health report proof vs staging: a planted 500 is caught, a healthy vault stays quiet
bun scripts/health-report.ts --d1 parachute-identity [--gate]   # "did anything get worse?" (read-only D1 SELECTs; deploy-prod.sh gates on it with --public: verdict + counts only, the deploy log is public)
```

## Load-bearing gotchas

- **Stale `file:` core dep** — `workers/vault` depends on `@openparachute/core` via `file:../../../parachute-core/packages/vault/core`; bun COPIES it at install. After any engine change, `bun install` or you test/deploy stale core (the deploy scripts do it; test runs don't).
- **DO SQLite rejects `BEGIN/COMMIT`** — core's `transaction()` duck-types the shim's `transactionSync`.
- **workerd ≠ vitest-workerd** — e.g. runtime caps PBKDF2 at 100k iterations, the test pool doesn't enforce it (green tests, every live login 500'd). ALWAYS live-smoke after deploy.
- **`wrangler dev` with the staging config is not offline** — the Workers AI binding is always remote, so it opens a session to the real Cloudflare account with whatever sign-in the machine has. The door contracts run the workers from a copy of the config without that binding, inside a sandbox with no network.
- **A request answered before its body is read drains a small one first** (`vault-do.ts` `dropUnreadBody`) — the router is still piping the body in; left unread, the pipe throws after the answer is out, local workerd restarts the worker, and the next requests get 503. Bounded (a declared length up to 1 MiB, two seconds), because it runs before sign-in: never let whoever is being refused hold the refusal open.
- **`wrangler deploy` success ≠ globally propagated** — an edge PoP can serve the old version minutes later. `/health`'s `version` field is per-PoP ground truth; `deploy-staging.sh` polls it against a pre-deploy baseline before smoking.
- **`TEST_JWKS`** is double-gated on `ENVIRONMENT="test"` — never set that in a deployed config.
- **`[observability]` is NOT inherited by named envs** — needed in BOTH scopes of both wrangler.tomls (top-level AND `[env.staging.observability]`).
- **PRODUCTION = the TOP-LEVEL wrangler config, and can NEVER move into an `[env.production]`.** Named envs re-suffix worker names; a renamed worker detaches the Custom Domains (`cloud.` / `u.parachute.computer`) and orphans every existing vault DO. Staging is `[env.staging]` (`wrangler deploy -e staging`, workers.dev origins only).
- **Staging's `routes = []` override is load-bearing** — without it staging inherits prod's custom-domain route.
- **Staging is its own Cloudflare account** (Parachute Staging, T-432): `[env.staging] account_id` pins it (wrangler prefers it over `CLOUDFLARE_ACCOUNT_ID`), and the top level has NO `account_id`, so production keeps the account `deploy-prod.sh` exports. Account id, workers.dev subdomain, D1 id and bucket live in `scripts/staging-account.env` (`test-bun/staging-account.test.ts` holds the tomls to it); staging URLs are `https://<worker>.<subdomain>.workers.dev`. A fresh account: `scripts/staging-bootstrap.sh`. Locally, `wrangler dev --env staging` needs `--local`: with the account pinned, wrangler otherwise opens a remote session for the vault's AI binding and fails without a login there.
- **The first-party `client_id` (`parachute-console`) is the vault-side platform-vs-tenant gate** (`workers/vault/src/auth.ts` `FIRST_PARTY_CLIENT_ID`) — scope/verb alone can't distinguish, because a vault owner can mint `vault:<name>:admin` via public OAuth.
- **`__test/*` + mock-billing endpoints must 404 in production** — smoke-prod-pinned; keep them pinned.
- **Stripe dep pinned EXACT** (`22.1.0`) — caret drift broke types on fresh installs (bun.lock committed since #104; the exact pin is defense-in-depth).
- **Snapshots carry NO attachment binaries** — say it everywhere user-facing; on-demand `/api/export` DOES stream them.
- **Raw transcript is sacred** — the cleaned note body is a derived view; the raw is always preserved on note + attachment metadata.
- **SPA CSP lives in `workers/identity/src/spa-csp.ts`**, shipped through TWO surfaces that must not drift: the generated `dist-assets/_headers` (`scripts/gen-spa-headers.ts`) + the worker's `/` Host-branch.
- **`BOUND_ORIGINS`** (prod `[vars]`) must include every non-issuer serving origin (`app.`, `my.`) or every cookie-authed POST from those origins 401s as "session expired".
- **Health counters are names and counts only** (T-411): vault DO KV `health:<day>` (NOT a SQLite table — the vault's schema, table count and exports must not change) → copied nightly into D1 `health_counters` by the usage rollup (the internal config GET carries them) → `health-report.ts` → the daily line's `worse N`, `/ops/health`, `deploy-prod.sh`'s gate. A new subject must be server-defined (route group, a visible tool's own name, a fixed label) — never a caller's string, message, name, path or email. Version labels need `[version_metadata]` in BOTH scopes of both wrangler.tomls. Name use per client (door/0.9, T-456: `health.ts` NameCounts) is its own sink, `names:<day>`: old and new names (the engine's own) by client (an app key's name, else the User-Agent's product token, reduced), at most 16 clients and 256 keys a day; read with GET /api/internal/health (staging: identity `GET /__test/names?vault=`), not yet copied into D1. The account door counts its own names (`name:account <tool>`, by client class) in D1 `health_counters`; the health report drops every `name:` row. A call through the account door is counted in both sinks, under different names (`name:account …` there, `name:mcp …`/`name:rest …` on the vault): a hop's client id is also what `/account/vaults/:name/token` mints, so the vault can't drop hops alone.
- Longer canonical notes live in code, not here: KDF posture → `workers/identity/src/users.ts`; CORS split → `workers/identity/src/oauth-shared.ts`.

## Critical rule: shared core + shared wire contract, forked runtime

The engine is `@openparachute/core` (parachute-core `packages/vault/core`; it moved there from parachute-vault `core/` with its history) — never reimplement schema/query/MCP-tool semantics here; PR core changes upstream. The WIRE contract (REST shapes, OAuth flows, MCP discovery, portable-md bytes) must match the bun vault byte-shaped. The RUNTIME (router/DO/R2/D1) diverges by design. Extend the conformance suites with every endpoint you add.

**The wire contract is a test, not a claim.** `scripts/door-parity.sh` runs parachute-core's door contracts (`contracts/suites/door`, pinned in `scripts/door-suite-source.env`) against both workers under local workerd and compares what an app could see (every MCP tool's schema and words, every refusal's status, code and hint, reply shapes, discovery, exported bytes) with the box's kept fingerprint. A difference fails CI unless parachute-core's `deliberate.json` names it with a reason and an owner. When it goes red: fix this door, or name the difference there in a core PR and move the pin; never edit the comparison.

## Governance / CI

- **Branches.** `next` is the trunk: branch from it, open a PR against it, never push to `next` or `main`. `main` lags `next` and feeds staging.
- **`door/0.9`** (T-430) is a long-lived side branch, never merged into `next`: Parachute Cloud on the 0.9 engine (T-456, cloud parity) and the own-Cloudflare single-owner door (`deploy/personal/README.md`). It takes `next` by merge (never the reverse) and pins its own engine (core `next`, `scripts/core-source.env`). Its MCP surface, connect-time brief, refusal words and record HEAD are the engine's (parachute-core mcp-surface.ts, projectionToMarkdown and http-validators.ts), the same code a box runs: never re-port them here. `deploy-staging.sh` takes its 0.9 pin (Cloud staging proves the 0.9 door), `deploy-prod.sh` refuses it: production stays on `next` until Aaron's rollout. CI runs on it; its door contracts run as both the `cloud` and the `personal` door, each against the `box-0.9.1` fingerprint (`DOOR_SUITE_DOOR` in `scripts/door-suite-source.env`); its vault suite runs in four shards (workerd runs out of heap with the 0.9 engine in one).
- **Review.** Every PR gets a fresh Claude reviewer (an agent that didn't write the code), recorded in a `## Review` section of the PR body with its verdict (round cap 3). GitHub approvals aren't used: Uni opens PRs and merges them into `next` as `unforcedagi` after the review says ship, so the review section is the record. A `next`→`main` promotion feeds staging, so Aaron (`unforced`) merges it; an agent never merges into `main`.
- **CI** (`.github/workflows/ci.yml`: identity worker, vault worker, door contracts, control plane) runs on every PR and every push to `main` and `next`, and must be green before merge. The deploy workflows' `ci-green` gates still name the three older jobs: door contracts must be green to merge, but a deploy doesn't wait for it yet (adding it there is a change to a deploy path, left for whoever owns deploys).
- **Version.** Every code-touching PR bumps rc.N in `package.json` (the package is never published; the bump is for history legibility). Workflow- or docs-only PRs don't.
- **Engine pin.** `ci.yml` and both deploy paths materialize the exact parachute-core commit pinned in `scripts/core-source.env` as a sibling `../parachute-core` (the `file:` core dep needs it), and the old hub repo's door contract pinned in `scripts/door-contract-source.env` as `../parachute-hub`. Locally, run `scripts/materialize-vault-core.sh` and `scripts/materialize-door-contract.sh` before `bun install`, or it prints "Failed to install 2 packages" and still exits 0. Promote the engine by bumping the pin. The door contracts have their own pin (`scripts/door-suite-source.env`, a parachute-core commit for `contracts/suites/door` only): black-box tests that follow core `next` while the engine pin stays where it is.
- **Deploys.** `deploy-staging.yml` runs on pushes to `main` that touch `workers/`, `scripts/` or the workflow itself, after its `ci-green` job sees all three CI jobs pass on that commit. `deploy-prod.yml` is manual-dispatch only and deploys the ref you dispatch (the default is `main`, which lags `next`: name the ref you mean); its `ci-green` job refuses a commit without a green CI run, then it waits for Aaron's `production` environment approval. Both secret-gates skip GREEN when secrets are unset — verify a NEW deployment actually landed before claiming deployed.
- **Public repo.** Everything here is world-readable: no private notes, real user data or secrets in code, tests, commits or PRs.

## License

AGPL-3.0.
