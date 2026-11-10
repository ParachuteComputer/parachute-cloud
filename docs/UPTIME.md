# Uptime: what checks production, and where the external check should run

Audit finding L6-03 (T-420). Short version: every check used to stop at the vault worker's router, and the one check
outside Cloudflare ran every 5.6 hours on average. Now a canary vault is read through the real path, inside and
outside Cloudflare. The external check should move to a systemd timer on a box outside Cloudflare.

## What runs now

| Check | Where | How often | What it proves |
|---|---|---|---|
| identity D1 `SELECT 1` | identity cron (`src/ops.ts`) | every 10 min | identity can reach its database |
| vault `/health` | identity cron, and `scripts/uptime-check.sh` | every 10 min / see below | the vault worker's router answers. It never wakes a vault DO |
| **canary vault** | identity cron (`src/ops-canary.ts`), and `scripts/uptime-check.sh` | every 10 min / see below | one vault's Durable Object boots and answers a client: one REST note read, one MCP `tools/list` |

A canary failure is a `vault-canary` health failure. It goes through the cron's alert path: every
`OPERATOR_ALERT_EMAIL` address plus `OPS_ALERT_WEBHOOK_URL`, deduped hourly per check, counted as `health_fail` in the
daily line. The alert names the failing step and the vault's answer, e.g.
`note read: HTTP 500 Internal server error (NewerSchemaError: …)`. That is what a DO with a boot error answers every
request with, and before this change nothing saw it until the next night's rollup.

With no canary configured, the cron logs `event=health_canary_skipped reason=not_configured` once per run and alerts
nothing. The script prints one "Canary vault: skipped" line.

## Why GitHub cron is not enough

`.github/workflows/uptime.yml` asks for `*/15` (96 runs a day). From 10-29 to 11-08 it ran 44 times, 3 to 5 a day:
mean gap 5.6 h, longest 10.2 h (`gh run list -w uptime.yml -L 200`). GitHub documents scheduled runs as best-effort:
they are delayed under load, especially at the top of the hour, and some are dropped. They only run from the default
branch, and they stop after 60 days without repository activity. An outage of the whole edge could wait 10 hours for
the one check that does not live on Cloudflare.

## Options for the external check

| | Keeps time | Outside Cloudflare | Open source | Can do the canary | Cost to run |
|---|---|---|---|---|---|
| **(a) systemd timer on a box outside Cloudflare** running `scripts/uptime-run.sh` | yes (`OnCalendar`, `Persistent=`) | yes | yes (systemd, bash, curl, jq) | yes, the shipped script | one unit pair on a box we already run |
| (b) scheduled Worker on a separate Cloudflare account | yes | **no**: same provider, same edge | our code | yes, if ported | a second account and deploy path |
| (c) self-hosted Gatus (Apache-2.0) or Uptime Kuma (MIT) | yes | yes | yes | not as a plain HTTP check: the canary needs a token first. The script would have to push its result to the monitor | a new service to run and keep up; adds history and a status page |

**Pick (a).** It runs the same script CI runs, needs nothing new to operate, and is the only option that is both
outside Cloudflare and already able to run the canary. (b) fails the point of an external check: a Cloudflare-wide
outage takes the monitor down with the thing it monitors. (c) is worth adding later if we want a public status page;
the timer would then push each result to it. Keep the GitHub workflow as a second opinion; it costs nothing.

One limit of (a): a home box can lose its own network. That raises a false "down" (the issue opens, then closes on the
next good run); it never hides a real outage while the box is up. To notice the box itself going quiet, add a
heartbeat later (e.g. a self-hosted healthchecks.io ping on each run).

## Steps (Uni / Aaron provision; nothing here has been provisioned)

1. **Canary vault.** Under an operator account (one of the accounts in `scripts/set-operator-role.ts`), create a vault
   for this and nothing else, e.g. `staff-canary`. Create one note at path `canary` with made-up text, e.g. "Canary
   note. Read every 10 minutes by the uptime check. Do not edit or delete." The checks refuse a vault whose name lacks
   `canary` or whose owner is not an operator, so a typo cannot point them at a real vault (operators own real
   vaults too; the name marker covers those). Do the same on staging with its own vault.
2. **Name it.** In `workers/identity/wrangler.toml`, set `CANARY_VAULT_NAME` in `[vars]` (production) and in
   `[env.staging.vars]` (staging). Add `CANARY_NOTE` only if the note is not at `canary`. This goes out with a normal
   reviewed deploy. From then on the identity cron reads it every 10 minutes.
3. **External credential** (only for the external check). `openssl rand -hex 32`, then
   `wrangler secret put OPS_CANARY_TOKEN` on the identity worker with that value. Its holder can call
   `POST /ops/canary-token` and get a 5-minute token that is read-only on the canary vault and nothing else:
   scope `vault:<canary>:read`, `aud` `vault.<canary>`, `client_id` `parachute-canary` (never first-party, so the
   vault's internal seam refuses it). The vault is chosen by `[vars]`, never by the caller. The cron needs no secret:
   the identity worker is the token issuer and mints its own 60-second token of the same shape.
4. **Monitor box.** On a box outside Cloudflare (uni works: the check goes out over the public internet), make a
   checkout used for nothing else, kept on `main` (`git clone -b main https://github.com/ParachuteComputer/parachute-cloud
   ~/Code/parachute-cloud-monitor`; update it with `git pull --ff-only` when the scripts change), so whatever branch a
   working checkout has out never becomes the monitor. Then write `~/.config/parachute-uptime/env` (mode 0600):

   ```sh
   CANARY_TOKEN_URL=https://my.parachute.computer/ops/canary-token
   CANARY_OPS_TOKEN=<the OPS_CANARY_TOKEN value>
   GH_TOKEN=<fine-grained token: Issues read/write on ParachuteComputer/parachute-cloud only>
   GITHUB_REPOSITORY=ParachuteComputer/parachute-cloud
   CHECKED_FROM=uni
   ```

   `~/.config/systemd/user/parachute-uptime.service`:

   ```ini
   [Unit]
   Description=Parachute Cloud external uptime check (docs/UPTIME.md)

   [Service]
   Type=oneshot
   EnvironmentFile=%h/.config/parachute-uptime/env
   ExecStart=/bin/bash %h/Code/parachute-cloud-monitor/scripts/uptime-run.sh
   # Worst case at the script defaults (ATTEMPTS=3, TIMEOUT=15, RETRY_DELAY=20): 85 s per hanging check, 3 health
   # URLs + canary token + canary reads ≈ 430 s. Leave room so a hang is reported, not killed.
   TimeoutStartSec=600
   ```

   `~/.config/systemd/user/parachute-uptime.timer`:

   ```ini
   [Unit]
   Description=Run the Parachute Cloud uptime check every 5 minutes

   [Timer]
   OnCalendar=*:0/5
   Persistent=true
   AccuracySec=30s

   [Install]
   WantedBy=timers.target
   ```

   Then `systemctl --user daemon-reload && systemctl --user enable --now parachute-uptime.timer`, and
   `loginctl enable-linger` so it runs while nobody is logged in. Check with
   `systemctl --user list-timers parachute-uptime.timer` and `journalctl --user -u parachute-uptime`.
5. **Optional:** set the repo secrets `CANARY_TOKEN_URL` and `CANARY_OPS_TOKEN` so the GitHub workflow runs the canary
   too.

To prove it end to end once set up: on staging, move or rename the canary note. The next cron run should log a
`vault-canary` failure (`note read: HTTP 404 …`), and `scripts/uptime-check.sh` pointed at staging should exit 1 with
the same reason. Put the note back and both go green. The boot-failure case itself is proven in workerd by
`workers/vault/test/canary.test.ts` (a real DO stamped with a newer schema).

## Still open from L6-03

- Log and count a DO's `bootError` once per instance (L6-03 item 2), so every vault that fails to boot is seen, not
  only the canary.
- A near-real-time vault 5xx count for the burst alert (item 3). It counts identity responses only today.
