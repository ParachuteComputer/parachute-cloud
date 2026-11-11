# Identity Worker — the OAuth issuer for cloud vaults

`@openparachute/identity-worker` — a Cloudflare Worker + D1 that reproduces the
hub's OAuth **issuer contract** exactly, so Claude.ai / Claude Code / ChatGPT
connectors and surface-client work against cloud vaults **with zero client
changes**. This is Phase 3 of the [vault-cloud-serverless
design](../../../parachute.computer/design/2026-07-02-vault-cloud-serverless-design.md)
(§3.2). The ground truth is the hub (`parachute-hub/src/oauth-handlers.ts`,
`signing-keys.ts`, `jwt-sign.ts`); every behavior here is ported from it and
pinned by the conformance corpus.

## Endpoints

| Route | What |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 PRM |
| `GET /.well-known/jwks.json` | RS256 public keys (`kid = base64url(SHA-256(pubkey PEM))`) |
| `GET /.well-known/parachute-revocation.json` | `{generated_at, jtis}`, `Cache-Control: max-age=60` |
| `GET/POST /oauth/authorize` | PKCE-S256 auth-code flow + login/consent |
| `POST /oauth/token` | `authorization_code` + `refresh_token` (rotation + grace + family revoke) |
| `POST /oauth/register` | RFC 7591 DCR (`none` + `client_secret_post`) |
| `POST /oauth/revoke` | RFC 7009 (always 200) |

Token response: `{access_token, token_type:"Bearer", expires_in:900,
refresh_token, scope, services}`. The `services` catalog maps `vault` /
`vault:<name>` → `https://<name>.<VAULT_BASE_DOMAIN>` (cloud subdomain
addressing). Access tokens: 15-min RS256 JWTs, claims `{scope, client_id,
vault_scope, sub, iss, iat, exp, aud, jti}`; `aud = vault.<name>` for a named
vault scope. Refresh tokens: 30-day, rotated on use, one-generation 30s grace
window (`REFRESH_GRACE_MS`), family revocation on replay.

## Handing a vault to another account (T-446)

The owner of a vault hands it to another account; the vault stays where it is (same name, `vault_id`, notes,
history, attachments, snapshots, write stamps). Only the owner changes. All four routes take the owner's own
account token (`POST /account/token`; an OAuth app's account grant or an app key is refused). Code:
`src/vault-handover.ts`; table: migration `0031_vault_handovers.sql` (new, additive).

| Route | What |
|---|---|
| `POST /account/vaults/<name>/handover` `{to}` | the owner offers the vault to the account with address `to`. One open offer per vault (409 `offer_exists`); it expires in 7 days. An address with no account gets the same 201 |
| `DELETE /account/vaults/<name>/handover` | the owner withdraws the open offer |
| `GET /account/handovers` | `{outgoing, incoming}`: open offers this account made, and open offers to its proven address |
| `POST /account/handovers/<id>/accept` | the receiving account accepts: one D1 batch changes the owner. A replay answers `already: true` |

Refusals teach: `vault_limit_reached` (the receiver's plan has no room; the offer stays open), `offer_expired`,
`offer_withdrawn`, `unverified_account`, `offer_unavailable` (the vault or the offering account is gone or closed),
`plan_frozen` (an ended plan can't offer), `vault_busy` (an import or restore is running).

What ends at the handover: the old owner's named app keys on that vault (the new owner mints their own), OAuth
tokens, standing consent and auth codes that name it, and, at the vault itself (`POST /api/internal/handover-cut`),
every token of the old owner issued before the handover. Their account, sessions and other vaults keep working.
Both accounts get an audit row (`vault_handover_*`, note `{vault_id, handover}`).

**Not on a single-owner door** (`OWNER_PUBKEY` set): it has exactly one account, so there is no one to hand a vault
to. The routes answer 403 `handover_unavailable`; to give a vault away, export it and import it at the other door.

## Layout

```
src/
  index.ts          Hono app — routes → the pure (db, req, deps) handlers
  signing-keys.ts   RSA-2048, kid derivation, JWKS
  tokens.ts         access-token signing + refresh-token registry + rotation
  auth-codes.ts     PKCE S256 auth codes (single-use)
  clients.ts        DCR client registry
  grants.ts         skip-consent-on-prior-grant
  audience.ts       inferAudience + resource/vault scope narrowing
  users.ts          login users (PBKDF2 — see DIVERGENCES)
  sessions.ts       login cookie
  csrf.ts           double-submit CSRF for the human forms
  ui.ts             login + consent HTML
  oauth-*.ts        authorize / token / register / revoke / metadata handlers
  crypto.ts         WebCrypto ports of the node:crypto primitives
migrations/         D1 schema (mirrors the hub's tables)
test/               the conformance corpus (vitest-pool-workers, real D1)
scripts/            DEV-ONLY dev-user seed generator
```

## Develop + test

```sh
bun install            # from the parachute-cloud workspace root
bun run typecheck
bun run test           # the conformance corpus in workerd (real D1 + jose + WebCrypto)
```

## Dev login user (local only)

The browser login/consent flow needs a user. `.dev-secrets` (gitignored) holds
the credential; `bun run seed:dev` hashes it (PBKDF2, matching `src/users.ts`)
and applies it to the local D1:

```sh
bun run seed:dev       # generates scripts/seed-dev-user.sql + wrangler d1 execute --local
```

Default dev email: `dev@parachute.computer` (password in `.dev-secrets`).
**DEV-ONLY — rotate/remove before any deploy.**

## Deliberate divergences from the hub

None on the wire contract (that's the point). Two off-wire simplifications,
both documented in-code:

1. **Password hashing** (`users.ts`): PBKDF2-SHA256 via WebCrypto, not the hub's
   argon2 (no argon2 on Workers). The password store never crosses the wire; the
   login surface is a forked runtime per design §5.
2. **No per-user vault-assignment matrix**: `vault_scope` is always `[]` (the
   hub's "unrestricted" sentinel). Cloud isolation is structural (one Durable
   Object per vault), not claim-narrowed within one issuer. The claim is still
   emitted for wire-shape parity; `aud` + `scope` are the real gates.

Also omitted (not needed here, no wire impact): the hub's operator-bearer /
first-client-wizard DCR auto-approve paths (the single-consent authorize flow
covers approval); the multi-vault services-catalog fan-out (a cloud token is
always narrowed to one vault).

## Status

Built on branch `ag-cloud-identity`. **Not deployed, no PR** — integration
happens after the Phase-0 spike PR merges (Phase 3 → Phase 5). `wrangler.toml`
carries a placeholder `database_id`; real bindings + deploy land at integration.
