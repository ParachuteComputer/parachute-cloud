# Vault API token auth — v0

Minimum-viable access control for the hosted vault REST surface.

## Threat model (v0)

- **In scope:** preventing unauthenticated internet clients from reading or
  writing another tenant's vault via `<vault>.parachute.computer/api/*`.
- **Out of scope (follow-ups):** scoped/read-only tokens, per-token rate
  limits, audit log, OAuth client flow, user-facing token-management UI
  beyond the create-time reveal.

## Model

One token = one `pvt_<24-byte-base64url>` string, generated with
`crypto.getRandomValues`. Stored only as `sha256` of the raw token. Raw
token is shown **once** at the moment of creation and never again.

Tokens live in the VaultDO's own SQLite (one table per vault), not in D1.
That keeps the token hash co-located with the data it gates, and means a
D1 outage doesn't take down auth.

```sql
CREATE TABLE vault_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,   -- sha256(raw) hex
  name TEXT NOT NULL,                -- "default", "laptop", etc.
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
```

## Flow

1. **Provisioning.** After CF custom-hostname registration and the D1 batch
   insert of `vaults` + `hostnames` both succeed, `provisionVault`
   internally calls the VaultDO's `POST /_internal/tokens` to create the
   initial `default` token. That route returns the raw token once.
   `provisionVault` surfaces it in its return value; the dispatcher
   relays it in the `/signup` response as `apiToken`, and the dashboard
   shows it on the `?created=&token=` landing once.

2. **Request path.** A tenant request to
   `<vault>.parachute.computer/api/notes` hits the dispatcher, which
   strips any incoming `X-Internal-Secret` header, forwards to the
   VaultDO, and lets the DO authorize:

   ```
   Authorization: Bearer pvt_<raw>
   ```

   The DO computes `sha256(raw)`, looks up `vault_tokens`, rejects on
   missing / `revoked_at IS NOT NULL`, updates `last_used_at`, and
   proceeds.

3. **Internal RPC.** `POST /_internal/tokens`, `GET /_internal/tokens`,
   `POST /_internal/tokens/:id/revoke` are gated by an
   `X-Internal-Secret` header matching `env.DO_INTERNAL_SECRET`.
   The dispatcher **strips** this header from all inbound client
   requests before forwarding, so a browser can never impersonate an
   internal RPC.

## Secret management

- `DO_INTERNAL_SECRET` is a single Worker-scoped secret shared by the
  dispatcher and every VaultDO instance. Any high-entropy string works.
- Rotation: `wrangler secret put DO_INTERNAL_SECRET` with a new value,
  redeploy. The DO picks it up on the next warm start. There is only one
  live value at a time — rotation is instantaneous, not windowed.
- Compromise of `DO_INTERNAL_SECRET` would let an attacker who can also
  reach a VaultDO (they can't, unless they're running this Worker) mint
  tokens. Treat it like any Worker secret.

## What this does NOT solve yet

- **Token management UI.** v0 shows the token once at create time. The
  dashboard has no list/revoke view yet. Users who lose the token must
  wait for v1 (planned: subpage listing tokens by name/created/last-used
  with a revoke button, plus a "create new token" action that re-reveals
  once).
- **Scopes.** Every token is read-write for the whole vault. No
  read-only, no per-MCP-tool scoping.
- **Rate limiting.** No per-token buckets.
- **Audit log.** `last_used_at` only; no per-request trail.
