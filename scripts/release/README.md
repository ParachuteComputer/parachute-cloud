# scripts/release: how cloud reaches production now

Production deploys from `door/0.9` (Cloud's trunk from the 0.9 move on, Aaron 11-14), through a sealed job card that
runs `prod-job.sh`: a short-lived key per job on Aaron's card, never a standing key in GitHub. `deploy-prod.yml` has no
working key: its `CLOUDFLARE_API_TOKEN` was refused on 11-17 (run 43926429495, code 10000). The CI staging token has
been invalid since 10-28.

| File | What it is |
|---|---|
| `prod-job.sh` | Ships the commit that staging proved to both production workers. It runs `deploy-prod.sh` unchanged (health gate, D1 migrations, propagation wait), then read-only checks and `smoke-prod.ts`. If anything fails, it rolls both workers back to the versions production ran before. The header lists the arguments, the env inputs (`EXPECT_LIVE_*`, `PROD_LIVE`, `HEALTH_GATE_ACK` for a worse finding already judged not this deploy's) and exit codes. |
| `bunx` | A shim first on PATH while a job runs `deploy-*.sh`, `staging-bootstrap.sh` and `health-report.ts`. Each `bunx wrangler` call gets its own child key (`d1` → d1-write, `r2` → r2-admin, the rest → workers-scripts-write). On the production account `wrangler deploy` becomes `versions upload` plus `versions deploy`, because the sealed workers key may not re-PUT custom domains. On the Parachute Staging account (no zone, so no custom domain) it stays a plain `wrangler deploy --env staging`. |
| `check-triggers.sh` | Refuses a release whose routes, custom domains, crons or Durable Object migrations differ from the live commit, because the shim can't deploy those. |
| `version-at-100.py` | Reads the version at 100% from `wrangler deployments status --json`. |

The staging job runs the same shim through `deploy-staging.sh`, then every suite on that one deploy. Since T-432 staging
is on its own account (Parachute Staging, `scripts/staging-account.env`), so the job runs under that account's standing
window with no card of its own; production keeps one card per deploy.

- **Staging job and suites:** `staging-train-job.sh` in the T-478 worktree (`~/Code/wt/cloud09-deploy/tools/`, copied
  from T-413's `~/Code/wt/cloud-train`). It writes the `SUMMARY.txt` that `prod-job.sh` requires.
- **Card line and payload:** `~/Code/wt/cloud09-deploy/CARD.md`, `tools/prod-09-job.sh` (the env inputs) and
  `tools/job-prod-09.json`.
- **Harness:** `tools/test/prod-job.test.sh` in the same worktree. It runs the real `deploy-prod.sh` with fake
  wrangler, curl, sealed CLI and smoke-prod, through every outcome (the health-gate ack among them).

## Rolling production back past typed keys (T-476)

Any rollback to a commit before door/0.9's T-476 stack (#437) can serve a typed key as a whole-vault key at its level
until it expires: those vault workers don't know a typed key's grant (`permissions.grant`). That includes
`prod-job.sh`'s own rollback: the new identity worker is live for up to the job's window before it rolls back, and a
typed key made then lasts a year. The risk is small but real. So before any manual rollback, and after any such
rollback (prod-job's included), count the live typed keys on the identity D1:

```sql
SELECT COUNT(*) FROM app_keys WHERE types IS NOT NULL AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
```

If it isn't 0, end them in D1. These are the two updates `DELETE /account/keys/<name>` makes, for every live typed
key. Tokens come first, because their subquery reads `app_keys`:

```sql
UPDATE tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE revoked_at IS NULL AND jti IN (SELECT jti FROM app_keys WHERE types IS NOT NULL AND revoked_at IS NULL);
UPDATE app_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE types IS NOT NULL AND revoked_at IS NULL;
```

Every identity worker, old or new, lists a token with `revoked_at` as revoked, so this works after the rollback too.
A vault refuses the key from its next revocation-list refresh. Then count again; it must be 0. Owners lose those keys
and make them again after the next upgrade. The alternative is to roll back only to #437 or later, which refuse a
typed key outright.

`deploy/personal/end-typed-keys.sh` is for one own-Cloudflare door, and only while its new identity worker is still
live. After a rollback, an older worker's key list has no `types`, so the script finds nothing and passes.

