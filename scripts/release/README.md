# scripts/release: how cloud reaches production now

Production deploys from `next`, through a sealed job card that runs `prod-job.sh`. This holds until Aaron decides
about `main`. Don't use `deploy-prod.yml`: it deploys the default branch, which is far behind `next`, so a default
dispatch would roll production back. The CI staging token has been invalid since 10-28.

| File | What it is |
|---|---|
| `prod-job.sh` | Ships the commit that staging proved to both production workers. It runs `deploy-prod.sh` unchanged (health gate, D1 migrations, propagation wait), then read-only checks and `smoke-prod.ts`. If anything fails, it rolls both workers back to the versions production ran before. The header lists the arguments and exit codes. |
| `bunx` | A shim first on PATH while a job runs `deploy-*.sh`, `staging-bootstrap.sh` and `health-report.ts`. Each `bunx wrangler` call gets its own child key (`d1` → d1-write, `r2` → r2-admin, the rest → workers-scripts-write). On the production account `wrangler deploy` becomes `versions upload` plus `versions deploy`, because the sealed workers key may not re-PUT custom domains. On the Parachute Staging account (no zone, so no custom domain) it stays a plain `wrangler deploy --env staging`. |
| `check-triggers.sh` | Refuses a release whose routes, custom domains, crons or Durable Object migrations differ from the live commit, because the shim can't deploy those. |
| `version-at-100.py` | Reads the version at 100% from `wrangler deployments status --json`. |

The staging job runs the same shim through `deploy-staging.sh`, then every suite on that one deploy. Since T-432 staging
is on its own account (Parachute Staging, `scripts/staging-account.env`), so the job runs under that account's standing
window with no card of its own; production keeps one card per deploy.

- **Staging job and suites:** `staging-train-job.sh` in the T-413 worktree (`~/Code/wt/cloud-train/tools/`). It writes
  the `SUMMARY.txt` that `prod-job.sh` requires.
- **Card lines and payloads:** `~/Code/wt/cloud-train/CARDS.md` and `tools/job-train-*.json`.
- **Harness:** `tools/test/prod-train-job.test.sh` in the same worktree. It runs the real `deploy-prod.sh` with fake
  wrangler, curl, sealed CLI and smoke-prod, through 17 outcomes.
