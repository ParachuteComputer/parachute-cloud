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
- **One address**: `https://<PREFIX>-identity.<sub>.workers.dev` (and `PUBLIC_DOMAIN`, when set) is your Parachute. Sign-in, the account, every
  vault (`/vault/<name>`, its REST and `/mcp`) and the root `/mcp` (every vault an AI may reach) answer there; the
  identity worker hands `/vault/*` and `/mcp` to the vault worker over their service binding. The vault worker's own address still works for anything already pointed at it.
- **workers.dev** always; one public name is optional (`PUBLIC_DOMAIN`, a host on a zone of the same account). The
  identity worker takes it as a Custom Domain, so the whole door answers there too (`/mcp`, `/account/mcp`,
  `/vault/<name>/…`), and it becomes the address the door gives out for vaults. The issuer stays the workers.dev
  identity (sign-in and consent happen there, as Cloud's happen at `cloud.` while people connect at `my.`), so every
  token, key and connection made before keeps working at both names. The Parachute app takes the issuer's address
  (below).
- **Backups**: every night at 04:00 UTC each vault is snapshotted into R2 (`<PREFIX>-vault`, under
  `vault-<name>/snapshots/`) with 14 daily, 8 weekly and 12 monthly kept. Attachments live in the same bucket.
  Restore is one call (below), always into a new vault.

## A profile

A profile is a small env file kept **outside** this public repo (it names an account and keys):

```bash
ACCOUNT_ID=<32 hex>          # the Cloudflare account; the deploy refuses to run on any other (or on Parachute's)
PREFIX=aaron-parachute       # workers <PREFIX>-vault and <PREFIX>-identity, D1 <PREFIX>-identity, R2 <PREFIX>-vault
WORKERS_SUBDOMAIN=           # <sub>.workers.dev; blank: asked of the account during the deploy (needs an API token)
OWNER_PUBKEY=npub1...        # or 64 hex; "rehearsal": a made-up key made by the deploy (staging only)
ADMIN_PUBKEYS=npub1...       # comma- or space-separated; "rehearsal" as above
OWNER_PLAN=power             # entry | standard | plus | power
# PUBLIC_DOMAIN=parachute.example.com   (optional: one public name, on the identity worker)
```

Beside it, `private/` (0700) holds what is never printed: the ops token the deploy makes, and a rehearsal's keys.

## Deploy

You need [Bun](https://bun.sh) 1.4+, git, and a Cloudflare account with a workers.dev subdomain (dashboard: Workers →
your subdomain). From a clean checkout of `door/0.9`:

```bash
bun install                                                    # "Failed to install 2 packages" is expected: deploy.sh fetches them
mkdir -p <profile dir>/private && bun deploy/personal/nip98.ts keygen <profile dir>/private/owner.key   # a key if you have none: prints OWNER_PUBKEY
bunx wrangler login                                            # or export CLOUDFLARE_API_TOKEN=… (below)
bash deploy/personal/deploy.sh <profile.env> <evidence dir>    # about a minute; prints both addresses
bun deploy/personal/smoke.ts <evidence>/deployed.env <private dir> <evidence>/SUMMARY.txt   # optional, keyless
```

With `wrangler login`, put `WORKERS_SUBDOMAIN` in the profile: the lookup needs an API token.
An API token instead of `wrangler login` needs, on that account: Workers Scripts Edit, D1 Edit and Workers R2 Storage
Edit (set `WORKERS_SUBDOMAIN` in the profile if the token can't read it). A public name
(`PUBLIC_DOMAIN`) also needs that zone's Workers Routes Edit and DNS Edit. The smoke needs the profile's own keys in
`private/` (`owner.key`, `admin.key`), so it runs as is only on a rehearsal profile.

**In a sealed job** (Uni's way): the job needs three templates on the profile's account: `d1-write`, `r2-admin`,
`workers-scripts-write`, and every wrangler call gets its own short-lived child key through `./wr`
(`sealed job --payload <job.json> -- bash deploy/personal/deploy.sh …`). With `PUBLIC_DOMAIN` the job is one template
instead, `worker-app` with the name's zone (the job's `zone_id`): it holds the three above plus DNS and Workers routes on that zone, and
every wrangler call takes a `worker-app` child. Run without a terminal, wrangler replaces a DNS record already on the
name, so back that record up first if the name was in use. Taking the name off again is not a redeploy (wrangler
leaves a Custom Domain in place): delete it through the API (`DELETE /accounts/<id>/workers/domains/<domain id>`), then
redeploy without `PUBLIC_DOMAIN`.

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
`https://<PREFIX>-identity.<sub>.workers.dev/vault/podcast/api/records` or `/mcp`. Its writes are named
(`createdVia: key:podcast-studio`). `DELETE /account/keys/podcast-studio` stops it on its next request.
One key can also cover several vaults, each at its own level (0.9.1): send `"vaults": {"podcast": "write", "notes":
"read"}` instead of `vault` and `can`. That key opens the account door (`https://<identity>/account/mcp`), not a
vault directly.

An app that writes for other people (a client portal) can be let say whom each write is for: mint its key with
`"on_behalf_of": true` (its name is then lowercase letters, digits, `.` and `-`, e.g. `fernhill-portal`). Its writes
may send `Parachute-On-Behalf-Of: client-42` (on MCP, the write tool's `on_behalf_of`) and are stamped
`createdBy: fernhill-portal:client-42`. A key without it that sends one is refused (403 `on_behalf_not_allowed`).

## Sign in from the Parachute app

On a phone or the desktop app, with your key in the app (on its first screen, **Advanced: paste a secret key**: an nsec
or the 64 hex `keygen` wrote): type your Parachute's address (the identity one), choose **Mine**, **Sign in with your
key**. The app signs one request with the key
(`POST /account/token`), opens a one-time sign-in link, and you allow it on the consent page. This needs an app build that includes ParachuteComputer/parachute#136 (merged 2026-11-21); an older one says "This hub doesn't take a key to sign in".
With a public name, the app still takes the identity's workers.dev address: it accepts only a hub that names itself
as the issuer, and the issuer stays workers.dev.

In a browser tab (the web build) there is no key, and this door sends no mail, so its sign-in page's email link goes
nowhere. Open a browser session first with the session link below, then sign in from the web build.

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

## More vaults

`OWNER_PLAN` sets the owner's vault count (`power`: 10). You are the operator here, so you can raise it (or lower it;
existing vaults are never touched) with the same lever Parachute Cloud's operators use: one D1 update, with your
wrangler sign-in (or in a sealed job with `d1-write`), from the checkout you deployed from, after your first sign-in:

```bash
bash deploy/personal/vault-limit.sh <profile.env> 25      # or `plan` to go back to OWNER_PLAN's count
```

## Keys for an AI, sharing and Changes (T-476)

Since the T-476 door/0.9 stack (parachute-cloud #437 to #441), this door does these as a Spark hub does (a typed
key reads the public page as a stranger, which is stricter than a hub):
- **A key for an AI that reaches only some types**: `POST /account/keys {name, vault, can, types: ["recipe"], kind:
  "agent"}`, or the app's Vault > Sharing. The vault keeps the grant and checks every request; the key sees and
  changes only those types, at REST, MCP, the live socket and files, and nothing that acts on the whole vault.
- **One list of who reaches a vault**, and End: `GET /account/vaults/<vault>/statements` (every key and connected app),
  `DELETE …/statements/<id>` (refused on its next request, or within a minute if the vault couldn't be told at once).
- **Add a pack** with write access: write may make a type and add fields to a type it made (`PUT /api/types/<name>`,
  MCP `manage-types`).
- **Changes lists deletes**: write access reads `GET /api/history/deleted` and puts a record back.
- **A public page for published records**: `https://<identity>/vault/<vault>/view/<id or path>`, published records only,
  for anyone with the link.

**Before rolling back** to any commit before this stack (#437; for example door/0.9 at 0d0bf9e, 612f2b0 or 4f7bedf),
end every typed key first: those vault workers don't know a typed key's grant and would serve it as a whole-vault
key. Run it before the rollback, while this door is still live (an older identity worker doesn't list `types`), and
make no typed key in between:

```bash
bash deploy/personal/end-typed-keys.sh https://<identity> <your key file>     # exit 1 if anything is unclear: don't roll back
```

Rolling back to #437 or #438 needs nothing: those refuse a typed key outright.

## What this door doesn't do yet

- **Sharing a vault with another person** (an invite they accept with their own key): a box does; a cloud-style door
  has no sign-in for a second person yet.
- **The app's link for a published record** needs an app build that reads this door's `published_view`; an older
  app says "This Parachute doesn't show published records to others yet". The page itself works.
- The refusal at the vault limit still says to write to Parachute's mail address: on your own door, use
  `vault-limit.sh`.

## Restore (one line)

```bash
curl -K acct.curl -X POST https://<identity>/account/vaults/<vault>/restore -d '{}'
```

The newest snapshot (or `{"key": "..."}` from `GET /account/vaults/<vault>/snapshots`) becomes a new vault,
`<vault>-restored-<date>`. To snapshot one vault now (before something risky):
`curl -H "Authorization: Bearer $(cat private/ops-run-token)" -X POST https://<identity>/ops/snapshot-run -d '{"vault":"<vault>"}'`.
