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
                    abuse fences. 71 tests (42 issuer conformance + 29
                    console/ownership/throttle).
src/                the OLD control plane (Worker + D1 + Stripe). Dormant; billing
                    lifecycle design gets harvested into the control-plane revival.
scripts/            deploy-dev.sh (reproducible dev deploy) + smoke-dev.ts (29-step
                    live smoke against the deployed workers).
```

## Commands

```sh
bun install                         # ALSO refreshes the copied core dep (see gotcha)
bun run test                        # control-plane tests (src/) — 123
bun run typecheck                   # root tsc
cd workers/vault && bun run typecheck && bun x vitest run    # 86+1 todo under workerd
cd workers/identity && bun run typecheck && bun x vitest run # 71
bash scripts/deploy-dev.sh          # deploy both workers (dev account) + seed
bun scripts/smoke-dev.ts            # live smoke vs the deployed workers
```

## Load-bearing gotchas

- **Stale `file:` dep**: `workers/vault` depends on `@openparachute/core` via `file:../../../parachute-vault/core`. Bun COPIES it into node_modules at install — after any vault-core change, `bun install` (or rm the `.bun` core dir) or you test/deploy against stale core. `deploy-dev.sh` does this automatically; test runs don't.
- **Transactions**: DO SQLite rejects `BEGIN/COMMIT`. Core's `transaction()` duck-types the shim's `transactionSync` (→ `ctx.storage.transactionSync`) since vault 0.6.5-rc.2. The conformance suite pins a GLOBAL-zero interception count; the sole residual is the async-batch path (cloud#25 — close or accept before real clients batch-write).
- **workerd ≠ vitest-workerd exactly**: workerd caps PBKDF2 at 100k iterations at runtime but vitest's pool does NOT enforce it (42/42 green while every live login 500'd). Live-smoke after deploy, always (`scripts/smoke-dev.ts`).
- **TEST_JWKS** in workers/vault auth is double-gated on `ENVIRONMENT="test"` — never set that in a deployed config.
- Dev deploy state: both workers live in the **Unforced Development** CF account on **branded Custom Domains** (the `parachute.computer` zone is in this account). **Console + OAuth issuer: `https://cloud.parachute.computer`** (`iss` = this origin); **vaults: `https://u.parachute.computer/vault/<name>/…`** (path routing — per-vault subdomains need proxied wildcard DNS, Enterprise-gated + a dns-edit token; see TRYIT). workers.dev URLs still resolve as a fallback. The live origins are baked into the `wrangler.toml` `[vars]` (self-contained — a bare `wrangler deploy` sets the correct `iss`, no `--var` to forget). A **self-serve console** (`/signup`, `/login`, `/console`) creates accounts + vaults; **vault ownership is enforced at the issuer** (`vaults` table in D1 — a user mints `vault:<name>:*` only for a vault they own). Login/signup have best-effort D1 abuse fences (per-IP signup + per-(IP,email) login lockout; DO-backed limiter is [issue #30]). Vault names are lowercased at creation, the router, and resource resolution (mixed-case URLs hit the canonical DO). Dev login: `dev@parachute.computer` (owns the grandfathered `demo` vault), password in `workers/identity/.dev-secrets` (gitignored).

## Critical rule: shared core + shared wire contract, forked runtime

The engine is `@openparachute/core` (in parachute-vault) — never reimplement schema/query/MCP-tool semantics here; PR core changes upstream (they must keep the bun suite green). The WIRE contract (REST shapes, OAuth flows, MCP discovery, portable-md bytes) must match the bun vault byte-shaped — that's what keeps the Notes PWA, Claude connectors, and export-anytime working identically. The RUNTIME (router/DO/R2/D1) is cloud-specific by design. Cross-runtime drift is caught by the conformance suites — extend them with every endpoint you add.

## Governance

Same as the workspace: PR-only, reviewer-gated, no self-merge. Root version bumps rc.N per code-touching PR (private package, never published — the discipline is for history legibility). No CI on this repo yet — cite literal local gate counts in PR bodies.

## License

AGPL-3.0.
