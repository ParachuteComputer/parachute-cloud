# Parachute Cloud

Hosted [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) on `*.parachute.computer`. Sign up, get your own subdomain at `<you>.parachute.computer`, run one or more vaults under it at `/v/<slug>/…`, connect any AI over MCP, pay monthly via Stripe.

> **Status:** scaffold. Architecture and skeleton only — nothing is deployed.

## The product

A hosted, per-tenant knowledge vault platform for AI agents. Every signup gets:

- **One subdomain per user** (`<you>.parachute.computer`) with HTTPS.
- **Many vaults under that subdomain**, each at `/v/<slug>/…` — `/v/default`, `/v/work`, `/v/journal`, etc. One Durable Object per `(user, slug)` pair, fully isolated SQLite.
- Same MCP tools, REST API, wikilinks, tags, and graph as self-hosted Parachute Vault.
- Attachments backed by R2.
- D1-backed API tokens. A token is either **user-scoped** (works on every vault the user owns) or **vault-scoped** (pinned to one slug). Manage them all from one dashboard.

Self-hosted Parachute Vault stays free and AGPL forever. Parachute Cloud is the paid, zero-setup version for people who don't want to run a server.

## Pricing

| Tier | Price | Vaults | Storage / vault | Notes |
|---|---|---|---|---|
| **Free** | $0 | 1 | 100 MB | A real vault, not a demo. |
| **Trial** | $1/mo | 1 | 500 MB | First paid step — removes friction. |
| **Personal** | $3/mo | 1 | 2 GB | Cheapest meaningful tier. |
| **Personal+** | $8/mo | 3 | 2 GB / vault | Matches Obsidian Sync. |
| **Pro** | $20/mo | 10 | 10 GB / vault (DO cap) | Power users + heavy agents. |

Tier enforcement happens in the dispatcher + in the vault DO on write.

## Architecture

```
      Browser / MCP client                Stripe                Clerk
             │                              │                     │
             ▼                              ▼                     ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  Dispatcher Worker (parachute-cloud)                             │
   │  - routes <name>.parachute.computer to a vault DO                │
   │  - /signup /dashboard /billing/webhook                           │
   │  - Clerk session + scoped token auth                             │
   └────────────┬─────────────────────────┬───────────────────────────┘
                │                         │
                ▼                         ▼
      ┌────────────────────┐    ┌───────────────────────┐
      │  VaultDO           │    │  D1 (accounts)        │
      │  (one per vault)   │    │  - users              │
      │  @openparachute/   │    │  - vaults             │
      │  vault-core/do     │    │  - subscriptions      │
      │  DoSqliteStore     │    │  - custom_hostnames   │
      └──────┬─────────────┘    └───────────────────────┘
             │
             ▼
         ┌────────┐
         │   R2   │   one bucket, keyed by vaults/<vault-id>/...
         └────────┘
```

### Stack

- **Cloudflare Workers for Platforms** — subdomain → DO dispatch. Each signup registers a Custom Hostname under `*.parachute.computer`. Vanity domains (`vault.alice.com`) work via the same Custom Hostnames API.
- **Durable Objects (SQLite storage)** — one DO per vault. Hosts `@openparachute/vault-core`'s `DoSqliteStore`. Storage, FTS5, triggers, schema are all identical to self-hosted.
- **R2** — attachments. Worker-proxies downloads (keeps auth consistent); move to pre-signed URLs if big media becomes common.
- **D1** — top-level accounts DB (users, vault ownership, subscriptions, custom hostnames). Small, relational, shared across tenants.
- **Clerk** — user auth. Session proves *who you are*; per-vault scoped tokens (inherited from vault-core) prove *what you can do in which vault*.
- **Stripe** — subscriptions + webhooks. Webhook updates the subscription row; dispatcher reads tier on every request.
- **Hono** — routing inside Workers. Fast, tiny, works cleanly with Clerk + Stripe middleware.

### Relationship to `parachute-vault`

Parachute Cloud **does not fork** parachute-vault. It imports it.

- `@openparachute/core` — the vault engine. Exposes the async `Store` interface, `DoSqliteStore`, MCP tool definitions, wikilinks, schema, path normalization.
  - **v0 dev wiring:** consumed as a file dep (`file:../parachute-vault/core`) because upstream hasn't published the core package to npm yet. Type-check uses a local `.d.ts` shim at `src/vendor/core-do.d.ts`; bundler resolves the real TS at build. Upstream issue: unprivate + publish `@openparachute/core`, then swap the dep + delete the shim.
- Everything in `src/` here is SaaS plumbing: dispatch, billing, signup, dashboard, multi-tenancy glue.
- Bug fixes and feature work on the core engine happen upstream in parachute-vault, never here. This repo pins a version.

### Request flow

1. Request arrives at `aaron.parachute.computer/v/work/api/notes`.
2. Dispatcher Worker reads `Host`, finds the owning user in D1 (cached in KV ~60s).
3. Dispatcher parses `/v/<slug>/…`, verifies the bearer token in D1 (`tokens` table, sha256-keyed), checks scope against the slug, enforces rate limit.
4. Dispatcher strips the `/v/<slug>` prefix and forwards the request to `env.VAULT_DO.get(idFromName("${userId}:${slug}"))`.
5. VaultDO handles it with `DoSqliteStore` — same MCP tool handlers as self-hosted.
6. Attachments hit R2, keyed by DO id — cross-tenant reads impossible by construction.

### Signup / onboarding

1. User hits `parachute.computer` → Clerk auth.
2. First login → `/onboarding/choose-hostname`. Picks a subdomain; live availability via `/api/check-hostname?name=…`.
3. Server calls `onboardUser()`:
   - Inserts `hostnames` row + sets `users.hostname`.
   - Registers a Cloudflare Custom Hostname record for `<subdomain>.parachute.computer`.
   - Creates a default vault (`slug=default`, `name=Default`).
   - Issues a user-scope API token named `default`; shows it to the user **once**.
4. Dashboard: create more vaults, issue more tokens (user-scope or vault-scope), rename, delete.
5. Paid tier → Stripe Checkout → webhook updates `subscriptions`.

### Tenancy boundaries

- A VaultDO has **no access to other vaults**. It only knows its own storage.
- The D1 accounts DB is read-only from the dispatcher's hot path (authorization check). Writes go through `/signup` + Stripe webhook handlers.
- Custom token scopes from vault-core (`full`, `read`) gate MCP/REST operations *within* a vault. The Clerk session gates *which vault(s)* the user can administer.

## Directory layout

```
parachute-cloud/
├── README.md               ← this file
├── CLAUDE.md               ← for tentacles working in this repo
├── package.json            ← pins @openparachute/core (file dep), Clerk, Stripe, Hono
├── wrangler.toml           ← Workers for Platforms dispatcher config
├── tsconfig.json
├── src/
│   ├── dispatcher.ts       ← top-level Worker: hostname → DO router + API surface
│   ├── vault-do.ts         ← VaultDO class wrapping DoSqliteStore
│   ├── billing/
│   │   ├── stripe.ts       ← checkout sessions, portal, webhook handler
│   │   └── tiers.ts        ← tier definitions + limit enforcement
│   ├── auth/
│   │   └── clerk.ts        ← Clerk session verification + user resolution
│   ├── signup/
│   │   └── provision.ts    ← new-user signup: users, vaults, custom hostname
│   └── dashboard/
│       └── index.ts        ← minimal user-facing dashboard
└── drizzle/
    └── schema.ts           ← D1 schema (users, vaults, subscriptions, custom_hostnames)
```

## Local development

Everything runs against `wrangler dev`'s local simulation — D1, DO SQLite, KV, and R2 all work offline.

```bash
# 1. Install (requires the parachute-vault repo as a sibling directory)
bun install

# 2. Create the local D1 database and apply the schema
wrangler d1 migrations apply accounts --local

# 3. Start the dev server (binds http://127.0.0.1:8787)
wrangler dev
```

In dev mode, Clerk session verification is replaced by an `X-Dev-User: <clerk-id>:<email>` header so you don't need a real Clerk tenant. Example:

```bash
# Onboard a pretend user (picks hostname + creates /v/default)
curl -X POST http://127.0.0.1:8787/signup \
  -H 'Content-Type: application/json' \
  -H 'X-Dev-User: dev-alice:alice@dev.local' \
  -d '{"subdomain":"alice"}'
# → {"hostname":"alice.parachute.computer","vaultSlug":"default",
#    "vaultUrl":"https://alice.parachute.computer/v/default",
#    "mcpUrl":"https://alice.parachute.computer/v/default/mcp",
#    "apiToken":"pvt_..."}

# Round-trip: vault requests live on the user's subdomain under /v/<slug>/
curl http://127.0.0.1:8787/v/default/api/notes \
  -H 'Host: alice.parachute.computer' \
  -H 'Authorization: Bearer pvt_...'

curl -X POST http://127.0.0.1:8787/v/default/api/notes \
  -H 'Host: alice.parachute.computer' \
  -H 'Authorization: Bearer pvt_...' \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello"}'
```

Smoke tests (`bun test tests/smoke.test.ts`) assume `wrangler dev` is already running on the default port. Set `CLOUD_BASE_URL` to point elsewhere.

## Using a hosted vault with `parachute-agent`

Every vault is reachable at `https://<you>.parachute.computer/v/<slug>/mcp`
with an API token (`pvt_…`) as the bearer. User-scope tokens work on every
vault you own, so one token can fan a single agent across several vaults:

```ts
export default {
  vault: {
    url: "https://aaron.parachute.computer/v/work/mcp",
    token: "pvt_XXXXXXXXXXXXXXXXXXXXXXXX",
  },
  // ... agents, triggers, etc.
};
```

Revoke tokens from the dashboard. Agents will see `401` the moment a token is
revoked — rotate first if you need zero downtime.

## Deployment

Production deploy steps live in [`DEPLOY.md`](./DEPLOY.md) — prereqs,
secrets, D1 migration, smoke checks, rollback.

## Deployment model

**Single Worker + Custom Hostnames**, not Workers for Platforms. Workers for Platforms requires Enterprise billing and we don't need user-uploaded Workers for v0 — one Worker can dispatch to any DO by name, and Custom Hostnames gives us wildcard SSL under `*.parachute.computer`. We revisit WfP only if we let tenants ship their own code.

One Worker (the dispatcher) fronts the whole system. It binds:

- `VAULT_DO` — Durable Object namespace for VaultDO instances.
- `ATTACHMENTS` — R2 bucket.
- `ACCOUNTS_DB` — D1 database.
- `ACCOUNTS_CACHE` — KV namespace (dispatcher cache).
- Clerk + Stripe secret env vars.

Everything lives in one Cloudflare account. No regions to pick — DOs pin themselves.

## Open source

**AGPL-3.0**, same as `parachute-vault`.

The hosted version is a managed offering, not a closed product. If someone wants to run Parachute Cloud themselves on their own Cloudflare account, they can — the code is right here. We charge for convenience, reliability, and not having to hold a Cloudflare bill.

## Non-goals (for now)

- Real-time sync / CRDTs between self-hosted and hosted vaults. Use `parachute vault push/pull` (export/import) instead.
- Team / shared vaults. Requires vault-core work first (see `vault-sharing-research.md`).
- On-prem enterprise. Self-hosted already covers this.
- Regions / geo-pinning beyond what DOs give by default.
