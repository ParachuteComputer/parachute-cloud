# Parachute Cloud

Hosted [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) on `*.parachute.computer`. Sign up, get your own vault at `<you>.parachute.computer`, connect any AI over MCP, pay monthly via Stripe.

> **Status:** scaffold. Architecture and skeleton only — nothing is deployed.

## The product

A hosted, per-tenant knowledge vault for AI agents. Every signup gets:

- A subdomain (`<name>.parachute.computer`) with HTTPS, ready for Claude Desktop / Claude Code / any MCP client.
- A fully isolated SQLite database (one Durable Object per vault) with the exact same MCP tools, REST API, wikilinks, tags, and graph as self-hosted Parachute Vault.
- Attachments backed by R2.
- Per-vault scoped API tokens, plus account-level management via a simple dashboard.

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

- `@openparachute/vault-core` — published from the vault repo. Exposes the async `Store` interface, `DoSqliteStore`, MCP tool definitions, wikilinks, schema, path normalization.
- Everything in `src/` here is SaaS plumbing: dispatch, billing, signup, dashboard, multi-tenancy glue.
- Bug fixes and feature work on the core engine happen upstream in parachute-vault, never here. This repo pins a version.

### Request flow

1. Request arrives at `aaron.parachute.computer/mcp`.
2. Dispatcher worker reads the `Host` header, looks up `(user_id, vault_id, tier)` in D1 (cached in Workers KV for ~60s).
3. Dispatcher checks tier limits (request rate, storage, whether subscription is active).
4. Dispatcher `env.VAULT_DO.get(idFromName(vault_id))` and forwards the request.
5. VaultDO handles it with `DoSqliteStore` — same MCP tool handlers as self-hosted.
6. Attachment requests hit R2 via the DO or (later) pre-signed URLs.

### Signup flow

1. User hits `parachute.computer` marketing site → "Sign up".
2. Clerk handles auth. On first login, `/signup/provision` creates:
   - A `users` row in D1 (Clerk ID → internal user ID).
   - A `vaults` row (`<chosen-subdomain>`, free tier).
   - A VaultDO instance (lazy — created on first request).
   - A Cloudflare Custom Hostname record for `<chosen-subdomain>.parachute.computer`.
3. User picks a paid tier → Stripe Checkout → webhook updates `subscriptions` row.
4. User issues scoped API tokens from the dashboard and plugs them into Claude Desktop / Code.

### Tenancy boundaries

- A VaultDO has **no access to other vaults**. It only knows its own storage.
- The D1 accounts DB is read-only from the dispatcher's hot path (authorization check). Writes go through `/signup` + Stripe webhook handlers.
- Custom token scopes from vault-core (`full`, `read`) gate MCP/REST operations *within* a vault. The Clerk session gates *which vault(s)* the user can administer.

## Directory layout

```
parachute-cloud/
├── README.md               ← this file
├── CLAUDE.md               ← for tentacles working in this repo
├── package.json            ← pins @openparachute/vault-core, Clerk, Stripe, Hono
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

## Deployment model

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
