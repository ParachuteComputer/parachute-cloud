# deploy/personal: your own Parachute on your own Cloudflare (door/0.9)

A single-owner Parachute: cloud's two workers under your own names on your own Cloudflare account, on the 0.9
engine (records, types) with 0.9.1's owner keys (Nostr sign-in, named app keys). It generalises the Arcade edge
pilot (`arcade-parachute-*`, T-335).

- **One owner**, signed in with a Nostr key (NIP-98 on `POST /account/token`). `OWNER_PUBKEY` is the owner;
  `ADMIN_PUBKEYS` are more keys that sign in **as the owner's account** while they are listed (an agent's own key,
  say). Revoking an admin is removing it from the list and deploying again; the owner is untouched. An admin may
  sign in first: it makes the owner's account, linked to the owner's key, never its own.
- **Closed**: no sign-up mail is ever sent (no mail binding), billing is off (no Stripe), the owner starts on
  `OWNER_PLAN` (default `power`: 10 vaults, 50 GiB of attachments).
- **workers.dev** by default; a custom domain is optional (`VAULT_DOMAIN`, `IDENTITY_DOMAIN`, each a Custom Domain on
  a zone of the same account).
- **Backups**: every night at 04:00 UTC each vault is snapshotted into R2 (`<PREFIX>-vault`, under
  `vault-<name>/snapshots/`) with 14 daily, 8 weekly and 12 monthly kept. Attachments live in the same bucket.
  Restore is one call (below), always into a new vault.

## A profile

A profile is a small env file kept **outside** this public repo (it names an account and keys):

```bash
ACCOUNT_ID=<32 hex>          # the Cloudflare account; the deploy refuses to run on any other (or on Parachute's)
PREFIX=aaron-parachute       # workers <PREFIX>-vault and <PREFIX>-identity, D1 <PREFIX>-identity, R2 <PREFIX>-vault
WORKERS_SUBDOMAIN=           # <sub>.workers.dev; blank: asked of the account during the deploy
OWNER_PUBKEY=npub1...        # or 64 hex; "rehearsal": a made-up key made by the deploy (staging only)
ADMIN_PUBKEYS=npub1...       # comma- or space-separated; "rehearsal" as above
OWNER_PLAN=power             # entry | standard | plus | power
# VAULT_DOMAIN=vault.example.com  IDENTITY_DOMAIN=id.example.com   (optional)
```

Beside it, `private/` (0700) holds what is never printed: the ops token the deploy makes, and a rehearsal's keys.

## Deploy (one sealed job)

The job needs three templates on the profile's account: `d1-write`, `r2-admin`, `workers-scripts-write`. Every
wrangler call gets its own short-lived child key through `./wr`.

```bash
bash deploy/personal/deploy.sh <profile.env> <evidence dir>    # inside: sealed job --payload <job.json> -- ...
bun deploy/personal/smoke.ts <evidence>/deployed.env <private dir> <evidence>/SUMMARY.txt   # keyless, after
```

The deploy is idempotent: run it again to upgrade in place. It refuses a non-0.9 engine pin, a dirty checkout, a
Parachute Cloud account and any `parachute-*` or `arcade-parachute*` prefix.

## Sign in, and point an app at it

```bash
bun deploy/personal/nip98.ts token https://<PREFIX>-identity.<sub>.workers.dev <your secret key file> /tmp/acct
# then, with that 10-minute account token:
curl -H "Authorization: Bearer $(cat /tmp/acct)" -X POST .../account/vaults -d '{"name":"podcast"}'
curl -H "Authorization: Bearer $(cat /tmp/acct)" -X POST .../account/keys -d '{"name":"podcast-studio","vault":"podcast","can":"write"}'
```

The app keeps that key (a year, one vault, read or write, never admin) and calls
`https://<PREFIX>-vault.<sub>.workers.dev/vault/podcast/api/records` or `/mcp`. Its writes are named
(`createdVia: key:podcast-studio`). `DELETE /account/keys/podcast-studio` stops it on its next request.

## Restore (one line)

```bash
curl -H "Authorization: Bearer $(cat /tmp/acct)" -X POST https://<identity>/account/vaults/<vault>/restore -d '{}'
```

The newest snapshot (or `{"key": "..."}` from `GET /account/vaults/<vault>/snapshots`) becomes a new vault,
`<vault>-restored-<date>`. To snapshot one vault now (before something risky):
`curl -H "Authorization: Bearer $(cat private/ops-run-token)" -X POST https://<identity>/ops/snapshot-run -d '{"vault":"<vault>"}'`.
