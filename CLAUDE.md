# Parachute Cloud

`@openparachute/cloud` — the **Vault Cloud**: Parachute's hosted offering ("pay us money, get a vault") on Cloudflare, plus the (to-be-revived) billing/provisioning control plane. **Reborn 2026-07-02** as a Workers monorepo per the decided direction — see `parachute.computer/design/2026-07-02-vault-cloud-serverless-design.md` (the design of record) and `Decisions/2026-07-02-cloud-do-per-vault` in the team vault.

> **The old Fly-Machines-per-user architecture this file used to describe is DEAD** (runtime discarded 2026-07-02; its billing/lifecycle *design* in `src/` is harvest material for the control-plane revival). If you're reading git history: everything pre-2026-07 describes the discarded shape.

## Mental model

> **One Durable Object per vault.** The DO's SQLite *is* the vault (schema v23 via `@openparachute/core` behind a `Database`-shaped shim); its isolation is the tenant boundary — a vault's code cannot address another tenant's data. Scale-to-zero: hibernated vaults bill ~storage only. Shared core + shared wire contract with the self-hosted bun vault; the runtime around core deliberately diverges (bounded, per the design's shared-vs-forked ledger).

## Layout

```
workers/vault/      the Vault DO + edge router — REST wire contract, MCP endpoint
                    (+ discovery chain), SSE live queries, R2 attachments + export
                    tarballs, caps. Conformance suite runs under real workerd
                    (@cloudflare/vitest-pool-workers).
workers/identity/   the OAuth issuer (authorize/token/DCR/JWKS/revocation on D1) —
                    reproduces the hub's issuer contract EXACTLY (conformance
                    corpus; rotation/replay/30s-grace/family-revocation). ALSO the
                    self-serve console (accounts + vaults, server-rendered),
                    vault-OWNERSHIP enforcement (vaults table), + login/signup
                    abuse fences. ALSO magic-link sign-in (the passwordless
                    default, via an EmailSender interface — CF Email Sending
                    binding, LIVE since 2026-07-02, with a dev-log fallback)
                    + optional TOTP 2FA (WebCrypto, ported from the hub;
                    enroll on /console/security). 98 tests.
src/                the OLD control plane (Worker + D1 + Stripe). Dormant; billing
                    lifecycle design gets harvested into the control-plane revival.
scripts/            deploy-staging.sh + smoke-staging.ts (full 29-step live smoke,
                    creates throwaway accounts/vaults) for STAGING; deploy-prod.sh
                    + smoke-prod.ts (read-only checks) for PRODUCTION.
```

## Commands

```sh
bun install                         # ALSO refreshes the copied core dep (see gotcha)
bun run test                        # control-plane tests (src/) — 123
bun run typecheck                   # root tsc
cd workers/vault && bun run typecheck && bun x vitest run    # 98+1 todo under workerd
cd workers/identity && bun run typecheck && bun x vitest run # 98
bash scripts/deploy-staging.sh      # deploy both workers -e staging + migrate + seed
bun scripts/smoke-staging.ts        # FULL live smoke vs staging (creates test debris)
bash scripts/deploy-prod.sh         # deploy both workers top-level + migrate (NO seed)
bun scripts/smoke-prod.ts           # READ-ONLY live checks vs production
```

## Load-bearing gotchas

- **Stale `file:` dep**: `workers/vault` depends on `@openparachute/core` via `file:../../../parachute-vault/core`. Bun COPIES it into node_modules at install — after any vault-core change, `bun install` (or rm the `.bun` core dir) or you test/deploy against stale core. Both deploy scripts do this automatically; test runs don't.
- **Transactions**: DO SQLite rejects `BEGIN/COMMIT`. Core's `transaction()` duck-types the shim's `transactionSync` (→ `ctx.storage.transactionSync`) since vault 0.6.5-rc.2. The conformance suite pins a GLOBAL-zero interception count; the sole residual is the async-batch path (cloud#25 — close or accept before real clients batch-write).
- **workerd ≠ vitest-workerd exactly**: workerd caps PBKDF2 at 100k iterations at runtime but vitest's pool does NOT enforce it (42/42 green while every live login 500'd). Live-smoke after deploy, always (`scripts/smoke-staging.ts` / `scripts/smoke-prod.ts`).
- **TEST_JWKS** in workers/vault auth is double-gated on `ENVIRONMENT="test"` — never set that in a deployed config.
- **Environments (the production/staging split, 2026-07-02)** — both live in the **Unforced Development** CF account (the `parachute.computer` zone is there):
  - **PRODUCTION = the TOP-LEVEL config in both `wrangler.toml` files.** It can never move into an `[env.production]`: named envs auto-suffix worker names, and a differently-named worker would detach the Custom Domains (and, for the vault worker, orphan every existing DO). Branded Custom Domains: **console + OAuth issuer `https://cloud.parachute.computer`** (`iss` = this origin, worker `parachute-identity`, D1 `parachute-identity`); **vaults `https://u.parachute.computer/vault/<name>/…`** (path routing, worker `parachute-vault-do`, R2 `parachute-vault-dev` — name grandfathered from the pre-split era; per-vault subdomains need proxied wildcard DNS, Enterprise-gated; see TRYIT). workers.dev URLs still resolve as a fallback. `ENVIRONMENT="production"`: the `x-parachute-dev-magic-link` echo header is NEVER emitted and magic-link email is REAL. Deploy: `bash scripts/deploy-prod.sh` (migrations, NO seeding — `dev@parachute.computer` already exists in prod and is retained as the operator login for now; revisit before public). Verify: `bun scripts/smoke-prod.ts` (read-only).
  - **STAGING = `[env.staging]` in both files** (`wrangler deploy -e staging`): auto-suffixed workers `parachute-identity-staging` / `parachute-vault-do-staging` on **workers.dev URLs only** (`routes = []` overrides the inheritable top-level custom-domain route — load-bearing, see the comment in each toml), own D1 (`parachute-identity-staging`) + R2 (`parachute-vault-staging`) + a fresh DO namespace. `ENVIRONMENT="staging"` → echo header ON; identity staging deliberately has **no `send_email` binding** → dev-log sender, so the magic-link flow is fully headless-testable with zero real email. The staging issuer is staging's own workers.dev origin and the staging vault's `ISSUER_ORIGIN` matches it (tokens never cross environments). Deploy: `bash scripts/deploy-staging.sh` (migrations + dev-user seed). Verify: `bun scripts/smoke-staging.ts` (the FULL smoke — creates throwaway accounts/vaults; never point it at prod).
  - The live origins are baked into each config's `[vars]`/`[env.staging.vars]` (self-contained — a bare `wrangler deploy` sets the correct `iss`, no `--var` to forget). Tests pin `ENVIRONMENT` in the vitest configs (miniflare bindings), so the deployed values don't affect either suite.
- Product state (both environments): a **self-serve console** (`/signup`, `/login`, `/console`) creates accounts + vaults; **vault ownership is enforced at the issuer** (`vaults` table in D1 — a user mints `vault:<name>:*` only for a vault they own). Login/signup have best-effort D1 abuse fences (per-IP signup + per-(IP,email) login lockout; DO-backed limiter is [issue #30]). Vault names are lowercased at creation, the router, and resource resolution (mixed-case URLs hit the canonical DO). Operator login: `dev@parachute.computer` (owns the grandfathered `demo` vault), password in `workers/identity/.dev-secrets` (gitignored; seeded into staging by deploy-staging.sh, pre-existing in prod). **Sign-in is magic-link-by-default** (`POST /auth/magic` → single-use hashed token, `GET /auth/verify` consumes it + creates-or-fetches the user; first link doubles as signup, passwordless accounts store an empty `password_hash`). Password stays supported (headless/dev depends on it) as an optional secondary set on `/console/security`. **Optional TOTP 2FA** (opt-in, `/console/security`): when enabled BOTH magic-link and password logins divert through `/login/2fa` before a session is minted; backup codes + a monotonic `totp_last_step` replay guard (D1, not the hub's in-memory cache). **Email**: the magic-link send is behind an `EmailSender` (`src/email.ts`) — the CF Email Sending `send_email` binding (**LIVE since 2026-07-02**: `parachute.computer` onboarded via `wrangler email sending enable`, SPF+DKIM in the zone, `[[send_email]]` bound in the top-level/production config only), with a **dev-log fallback** when unbound (= staging, by design). The link-echo affordance is INDEPENDENT of the sender: while `ENVIRONMENT !== "production"`, `POST /auth/magic` echoes the link in an `x-parachute-dev-magic-link` header (headless tests + smoke-staging depend on it); production (`ENVIRONMENT="production"`) never emits the header.

## Critical rule: shared core + shared wire contract, forked runtime

The engine is `@openparachute/core` (in parachute-vault) — never reimplement schema/query/MCP-tool semantics here; PR core changes upstream (they must keep the bun suite green). The WIRE contract (REST shapes, OAuth flows, MCP discovery, portable-md bytes) must match the bun vault byte-shaped — that's what keeps the Notes PWA, Claude connectors, and export-anytime working identically. The RUNTIME (router/DO/R2/D1) is cloud-specific by design. Cross-runtime drift is caught by the conformance suites — extend them with every endpoint you add.

## Governance

Same as the workspace: PR-only, reviewer-gated, no self-merge. Root version bumps rc.N per code-touching PR (private package, never published — the discipline is for history legibility). No CI on this repo yet — cite literal local gate counts in PR bodies.

## License

AGPL-3.0.
