# deploy/personal: your own Parachute on your own Cloudflare (door/0.9)

A single-owner Parachute: cloud's two workers under your own names on your own Cloudflare account, on the 0.9
engine (records, types) with 0.9.1's owner keys (Nostr sign-in, named app keys). It generalises the Arcade edge
pilot (`arcade-parachute-*`, T-335).

- **One owner**, signed in with a Nostr key (NIP-98 on `POST /account/token`). `OWNER_PUBKEY` is the owner;
  `ADMIN_PUBKEYS` are more keys that sign in **as the owner's account** while they are listed (an agent's own key,
  say). An admin may sign in first: it makes the owner's account, linked to the owner's key, never its own. An admin
  can't add or remove the account's sign-in keys (so it can't keep itself on) and can't delete the account. Everything
  else is the admin's to do, as the owner's: make, restore and **delete vaults**, mint and revoke app keys, claim the
  handle. List only a key you'd trust with that; nightly snapshots are the net for a deleted vault only while its
  snapshots remain (a vault's delete takes its restore points with it). **Revoking an admin**: remove it from the
  list and deploy again; it can't sign in from then on, and its last 10-minute account token runs out. App keys it
  made stay until revoked by name (`DELETE /account/keys/<name>`; name them for the admin, e.g. `uni-*`). The owner
  is untouched.
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
bun deploy/personal/nip98.ts token https://<PREFIX>-identity.<sub>.workers.dev <your secret key file> acct.curl
# then, with that 10-minute account pass (a curl config holding it):
curl -K acct.curl https://<identity>/account/vaults -d '{"name":"podcast"}'
curl -K acct.curl https://<identity>/account/keys -d '{"name":"podcast-studio","vault":"podcast","can":"write"}'
```

The app keeps that key (a year, one vault, read or write, never admin) and calls
`https://<PREFIX>-vault.<sub>.workers.dev/vault/podcast/api/records` or `/mcp`. Its writes are named
(`createdVia: key:podcast-studio`). `DELETE /account/keys/podcast-studio` stops it on its next request.

## Connect an app that signs in through a browser (a Claude connector)

An app that uses OAuth sends you to this door's sign-in page, and a key has no browser session. So open one
first, with your account pass (0.9.1, `POST /account/session-link`):

```bash
bun deploy/personal/nip98.ts token https://<identity> <your secret key file> acct.curl
# Simplest: sign the browser in, then add the connector
curl -K acct.curl https://<identity>/account/session-link -d '{}'
#   → {"url":"https://<identity>/auth/verify?token=…","expires_at":"…","next":"/console"}
# Or carry the app's pending request: copy the /oauth/authorize?... address from the tab the app opened
curl -K acct.curl https://<identity>/account/session-link \
  -d '{"next":"/oauth/authorize?response_type=code&client_id=…&state=…"}'
```

Open `url` in your browser within 5 minutes. It works once. Then add the connector (or retry it): its sign-in
page goes straight to the consent screen.

- The link is a full browser session (90 days, like any sign-in). Treat it like a password.
- Only your own account pass mints one. An app key, an app's OAuth token and an `ADMIN_PUBKEYS` sign-in are refused.
- `OWNER_PUBKEY` must stay set: it is what opens this route. On Parachute Cloud the route does not exist.
- Keep `APP_ORIGIN` unset or equal to the issuer: the link is built on the issuer, and consent on another origin
  would not see the cookie.

## Restore (one line)

```bash
curl -K acct.curl -X POST https://<identity>/account/vaults/<vault>/restore -d '{}'
```

The newest snapshot (or `{"key": "..."}` from `GET /account/vaults/<vault>/snapshots`) becomes a new vault,
`<vault>-restored-<date>`. To snapshot one vault now (before something risky):
`curl -H "Authorization: Bearer $(cat private/ops-run-token)" -X POST https://<identity>/ops/snapshot-run -d '{"vault":"<vault>"}'`.
