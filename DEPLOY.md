# Deploying parachute-cloud

This runbook takes a freshly-checked-out repo to a live `parachute.computer`
that can sign up users, provision their subdomain, and serve `/v/<slug>/api/*`
per-tenant vault routes. Assumes production Cloudflare, Clerk, and Stripe
accounts.

**v0.4 note:** the schema is a clean break from v0.3. The migration file is
named `0002_v04_schema.sql` (not `0002_v04_schema.sql`) so `wrangler d1 migrations
apply` still runs on machines that already executed a v0.3 `0002_v04_schema.sql` —
the file leads with `DROP TABLE IF EXISTS` for the old tables and re-creates
the v0.4 shape. Any v0.3 production data is blown away; migrate or back up
first if you have real tenants. Custom Hostnames are now registered once per
user (not once per vault), so the existing wildcard plan is sufficient and
less API churn hits Cloudflare during onboarding.

> ⚠️ **MCP endpoint is a v0.5 feature.** The `/v/<slug>/mcp` path is wired in
> the dispatcher but returns a stub. Production clients should target the REST
> API at `/v/<slug>/api/*` until v0.5 ships the real MCP handler.

Nothing here is automated; every command is something you run.

## 1. Prerequisites

- A Cloudflare account with `parachute.computer` on it as a zone.
- `wrangler` logged in (`wrangler login`).
- A Clerk production application with Sign-In With Google (or similar) enabled.
  Note its `Secret Key` and `Publishable Key`.
- A Stripe production account with price objects for the paid tiers. Note the
  `Secret Key` and a `Webhook Secret` (create one pointing at
  `https://parachute.computer/billing/stripe/webhook`).
- `bun install` completed at the repo root.

## 2. Create the backing resources

```sh
# D1 (accounts DB)
wrangler d1 create parachute-cloud-accounts
# → copy the database_id into wrangler.toml under [[d1_databases]]

# R2 (attachments)
wrangler r2 bucket create parachute-cloud-attachments

# KV (dispatcher hostname cache)
wrangler kv namespace create ACCOUNTS_CACHE
# → copy the id into wrangler.toml under the ACCOUNTS_CACHE binding

# KV (per-vault rate-limit counters)
wrangler kv namespace create RATE_LIMIT_KV
# → copy the id into wrangler.toml under the RATE_LIMIT_KV binding
```

## 3. Apply D1 migrations

```sh
wrangler d1 execute parachute-cloud-accounts \
  --file=drizzle/migrations/0002_v04_schema.sql --remote
```

Re-run the same command for each additional migration file as they appear
under `drizzle/migrations/`.

## 4. Set secrets

```sh
wrangler secret put CLERK_SECRET_KEY
wrangler secret put CLERK_PUBLISHABLE_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put CF_API_TOKEN          # token with Zone:Custom Hostnames:Edit
wrangler secret put CF_ZONE_ID            # parachute.computer zone id
wrangler secret put DO_INTERNAL_SECRET    # openssl rand -hex 32
```

`DO_INTERNAL_SECRET` is the dispatcher↔VaultDO shared secret. It must be
high-entropy and unpredictable; rotate it to invalidate any on-the-wire copy.

## 5. Deploy

```sh
wrangler deploy
```

This publishes the Worker and registers the `VaultDO` Durable Object class
(SQLite-backed, via the `v1` migration in `wrangler.toml`).

The custom-hostname-per-vault pattern requires SSL for SaaS or a suitable
custom-hostname plan on the zone. Confirm `wrangler custom-domains list`
shows the Worker routed on `parachute.computer` and `*.parachute.computer`
(the wildcard may need a paid plan; without it, each vault subdomain falls
back to the default workers.dev route).

## 6. Post-deploy smoke test

```sh
curl https://parachute.computer/health
# {"ok":true,"service":"parachute-cloud","version":"0.4.0","timestamp":...,"checks":{"d1":true,"r2":true}}
```

If `ok` is false, inspect `checks` — a `d1:false` usually means the migration
step was skipped; `r2:false` means the bucket name in `wrangler.toml` doesn't
match what was created.

Full end-to-end smoke (signup → token → note) from a dev machine:

```sh
CLOUD_BASE_URL=https://parachute.computer bun test tests/smoke.test.ts
```

Note: the signup test requires a signed-in Clerk session or the dev bypass
header, which is rejected in production. Against prod, restrict smoke to the
`/health` test only; run the full suite against a staging deploy.

## 7. Monitoring

- **Cloudflare Workers Observability** tab on the `parachute-cloud` Worker —
  request volume, error rate, CPU time. Enable Logpush to a sink if you want
  structured logs off-platform.
- Alert on `/health` returning `503` for more than one minute from an external
  uptime checker (the Worker itself can't reliably alert on its own liveness).
- Rate-limit key space lives in the `RATE_LIMIT_KV` namespace. Inspect by
  prefix `rl:` if you need to audit a specific vault.

## 8. Rollback

List recent deployments and re-activate a prior one:

```sh
wrangler deployments list
wrangler rollback --message "rollback to <id>" <deployment-id>
```

Rollback re-points routing at a prior Worker bundle — Durable Object state,
D1 data, and R2 objects are untouched. If a deploy introduced a breaking
migration, roll back the Worker first, then manually reverse the migration
via `wrangler d1 execute ... --remote` against a corrective SQL file.

## 9. Lifecycle in production (v0.4)

- **Onboarding** is atomic from the user's point of view: `POST /signup`
  registers the CF custom hostname, writes the `hostnames`/`users`/`vaults`
  rows in a single D1 batch, and issues an initial user-scope `pvt_` API
  token. CF registration is rolled back if the D1 batch fails.
- **Adding a vault** from the dashboard (`POST /dashboard/vaults`) inserts a
  new `vaults` row. No CF hostname call — all of a user's vaults live under
  the single hostname already registered at onboarding.
- **Deleting a vault** from the dashboard hard-deletes the `vaults` row
  (D1 first, to stop routing immediately), then POSTs `/_internal/wipe-r2`
  to the DO to remove every attachment under its R2 prefix. The Durable
  Object's own SQLite storage persists (CF has no public delete API), but
  it is unreachable once the D1 row is gone.
- **Account deletion** is not yet exposed as a dashboard flow; removing a
  user requires operator-side SQL (delete tokens → delete vaults → delete
  hostname row → unregister CF custom hostname → delete user).
