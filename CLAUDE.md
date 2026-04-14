# Parachute Cloud

Hosted, multi-tenant SaaS wrapping `parachute-vault` on Cloudflare. One Worker (dispatcher) + one Durable Object per vault + R2 + D1 + Clerk + Stripe.

Read `README.md` for the product + architecture overview. This file is for the agents (tentacles) working *in* this repo.

## Tech stack

- **Runtime:** Cloudflare Workers (ES modules), Durable Objects with SQLite storage.
- **Language:** TypeScript. No Bun here — Workers runtime.
- **Vault engine:** `@openparachute/vault-core` (imported from parachute-vault). Specifically `DoSqliteStore` + the async `Store` interface.
- **Routing:** Hono inside the Worker.
- **Auth:** Clerk (session) + vault-core scoped tokens (per-vault API access).
- **Billing:** Stripe (subscriptions + webhooks).
- **Storage:** Durable Object SQLite (per-vault) + R2 (attachments) + D1 (accounts).
- **Deploy:** `wrangler deploy`. Workers for Platforms + Custom Hostnames for subdomain routing.

## Architecture summary

```
<name>.parachute.computer → dispatcher Worker → VaultDO(<vault-id>) → DoSqliteStore
                                    │
                                    ├── D1 accounts (users, vaults, subs, hostnames)
                                    ├── R2 attachments
                                    ├── Clerk (session)
                                    └── Stripe (billing)
```

- **Dispatcher** (`src/dispatcher.ts`) — every request lands here. Resolves hostname → vault, checks tier, forwards to the VaultDO, or handles `/signup`, `/dashboard`, `/billing/webhook`, etc. directly.
- **VaultDO** (`src/vault-do.ts`) — one instance per vault. Wraps `DoSqliteStore`. Exposes the same MCP tools + REST endpoints as self-hosted vault. No cross-tenant access.
- **D1 accounts DB** — relational lookup for `hostname → vault → user → subscription`. Small, read-mostly, shared.

## Critical rule: do not touch vault core here

The notes/tags/links/MCP engine lives in `parachute-vault`. This repo **imports** it as `@openparachute/vault-core`.

- If you find a bug in note creation, wikilink resolution, schema, etc. — fix it **upstream in parachute-vault** and bump the pinned version here.
- If you need a new capability in the core store, open a PR against `parachute-vault` first.
- Only SaaS plumbing (auth, billing, dispatch, signup, dashboard, tier enforcement) belongs in this repo.

This split is load-bearing. Drift between core and its hosted wrapper is how forks start.

## Directory structure

```
src/
├── dispatcher.ts       top-level Worker (Hono app + DO dispatch)
├── vault-do.ts         Durable Object class — wraps DoSqliteStore
├── billing/
│   ├── stripe.ts       checkout, portal, webhook
│   └── tiers.ts        tier limits (requests, storage, vault count)
├── auth/
│   └── clerk.ts        Clerk session middleware
├── signup/
│   └── provision.ts    create user + vault + custom hostname
└── dashboard/
    └── index.ts        user-facing HTML dashboard (vault list, tokens, billing)
drizzle/
└── schema.ts           D1 schema for accounts DB
wrangler.toml           Workers for Platforms dispatcher config
package.json
```

## Common commands

```bash
# Once set up (not yet wired):
bun install              # install deps (Bun used only as package manager; runtime is Workers)
wrangler dev             # local dev, full Workers runtime with DO + D1 simulation
wrangler deploy          # deploy dispatcher + DO bindings
wrangler d1 migrations apply accounts   # run D1 migrations
wrangler tail            # stream logs
bun run typecheck        # tsc --noEmit
```

## How tentacles should work in this repo

1. Read `README.md` first for the mental model. It covers tenancy, pricing, and the dispatcher ↔ DO split.
2. Before making a change that feels like it's in the *vault engine*, pause and ask: "is this `vault-core` territory?" If yes, stop — PR upstream.
3. Keep the dispatcher thin. Any long-running logic belongs inside a DO, not in the dispatcher.
4. Every authenticated code path goes through either Clerk (user → admin actions) or scoped tokens (agent → vault actions). Never invent a third auth primitive.
5. Tier enforcement lives in two places: dispatcher (rate/quota on the hot path) and VaultDO (hard storage cap). Don't scatter limits further.
6. D1 is for account-level state. Per-vault data never leaves its DO.
7. Feature branches always. Never commit to main. Open a PR when done. (Inherited from UnforcedAGI conventions.)
8. No secrets in files. Use `wrangler secret put` for Stripe / Clerk keys.

## Self-review before handing back

- Did any change duplicate or reach into vault-core logic? If so, move it upstream.
- Did any code path escape the VaultDO boundary for per-vault data? It shouldn't.
- Do tier limits still apply on every paid path?
- Does signup correctly provision (D1 row + Custom Hostname + lazy DO)?
- Does tearing down an account release the Custom Hostname + mark the DO for deletion?
