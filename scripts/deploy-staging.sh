#!/usr/bin/env bash
#
# deploy-staging.sh — reproducible deploy of the two Vault Cloud workers to the
# STAGING environment ([env.staging] in both wrangler.toml files). Idempotent:
# safe to re-run. Provisioning (staging D1 + R2 + secrets) is one-time:
# scripts/staging-bootstrap.sh, which then runs this script.
#
# STAGING SHAPE (production/staging split 2026-07-02; own account since T-432):
#   - its OWN Cloudflare account, "Parachute Staging" (scripts/staging-account.env),
#     never the production account: a staging key there cannot touch production.
#   - workers.dev URLs ONLY (no custom domains — those belong to production):
#       console + OAuth issuer:  https://parachute-identity-staging.<subdomain>.workers.dev
#       vaults (path routing):   https://parachute-vault-do-staging.<subdomain>.workers.dev/vault/<name>/...
#     (<subdomain> = STAGING_WORKERS_SUBDOMAIN in scripts/staging-account.env)
#   - its OWN D1 (parachute-identity-staging) + R2 (parachute-vault-staging) +
#     a fresh DO namespace (a different worker = different Durable Objects).
#   - ENVIRONMENT="staging": POST /auth/magic echoes the link in the
#     `x-parachute-dev-magic-link` header, and identity staging deliberately has
#     NO send_email binding → the dev-log email fallback. Together: the
#     magic-link flow is fully testable headlessly, with no real email sent.
#   - the dev user (workers/identity/.dev-secrets) is seeded here, owning the
#     grandfathered `demo` vault — same as production's operator login.
#
# After deploying:  bun scripts/smoke-staging.ts   (the FULL smoke — it creates
# throwaway accounts/vaults, which is exactly what staging is for)
set -euo pipefail
# The engine lines staging takes: 0.8 (next), and 0.9 (door/0.9, T-456: Cloud staging proves the 0.9 door against the
# box's contracts before any production plan). Production stays on 0.8: deploy-prod.sh still refuses a 0.9 pin.
case "$(. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/core-source.env"; echo "$PARACHUTE_CORE_VERSION")" in
  0.8.* | 0.9.*) ;;
  *) echo "refused: this checkout pins an engine staging doesn't take (0.8 or 0.9 only)" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=staging-account.env
. "$ROOT/scripts/staging-account.env"
# The staging account, whatever the caller had: [env.staging] also pins it as account_id (which wrangler prefers), so
# both agree; a production id here would only be a confusing log line.
export CLOUDFLARE_ACCOUNT_ID="$STAGING_ACCOUNT_ID"

IDENTITY_STAGING="https://parachute-identity-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev"
VAULT_STAGING="https://parachute-vault-do-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev"

# The staging D1 must exist on the staging account first (staging-bootstrap.sh makes it and writes its id).
if [ "$STAGING_D1_ID" = 00000000-0000-0000-0000-000000000000 ] \
   || ! grep -q "database_id = \"$STAGING_D1_ID\"" "$ROOT/workers/identity/wrangler.toml"; then
  echo "refused: the staging D1 id is the placeholder or differs between scripts/staging-account.env and" \
       "workers/identity/wrangler.toml. Run scripts/staging-bootstrap.sh once (it creates the D1 and writes the id)." >&2
  exit 2
fi
# Verify the exact pinned parachute-core engine commit (cloud#45, cloud#59) and the
# shared Hub contract before the workspace install snapshots either file:
# dependency into node_modules. This is the local-deploy close for cloud#59:
# without it, a developer's sibling parachute-core checkout on some other
# branch would get silently copied into node_modules and deployed.
bash "$ROOT/scripts/materialize-vault-core.sh"
bash "$ROOT/scripts/materialize-door-contract.sh"
# Refresh the copied file: dep FIRST — bun snapshots @openparachute/core into
# node_modules at install time, so a vault-core change upstream is INVISIBLE to
# builds until re-installed (bit us 2026-07-02: stale txn.ts tested green,
# deployed stale). One bun install makes every deploy build against current core.
(cd "$ROOT" && bun install)

# --- SPA bundle — build the Parachute App the identity worker serves via
# Workers Static Assets INTO workers/identity/dist-assets BEFORE its deploy (the
# [assets].directory must exist at `wrangler deploy` time). The workflow fetches
# the exact parachute-app commit in scripts/spa-source.env as a sibling checkout;
# build-spa.sh verifies its version and builds the origin-root shape. Fail before
# either worker deploys if the browser artifact cannot be reproduced.
bash "$ROOT/scripts/build-spa.sh"

# --- one-time provisioning: scripts/staging-bootstrap.sh (D1 + R2 on the staging
# account, the D1 id into wrangler.toml, then this script, then the secrets).

# --- vault DO worker (DO SQLite + R2 + scope-guard against staging identity) --
# Deployed FIRST: the identity worker's [[env.staging.services]] binding
# (VAULT_SERVICE) references this worker by name — on a fresh account the
# identity deploy would fail if the vault worker didn't exist yet.
cd "$ROOT/workers/vault"
# DO SQLite migration (new_sqlite_classes, top-level [[migrations]]) applies
# automatically on deploy. ISSUER_ORIGIN in [env.staging.vars] points at the
# STAGING identity worker so token `iss` + JWKS validate within staging.
bunx wrangler deploy --env staging

# --- identity worker (OAuth issuer on the STAGING D1) ------------------------
cd "$ROOT/workers/identity"
bunx wrangler d1 migrations apply parachute-identity-staging --remote --env staging
# The dev user (and the grandfathered "demo" vault) is seeded from the gitignored .dev-secrets. A deploy from a
# checkout without that file leaves the staging dev user as it is (re-seeding would change its password under the
# smoke runs that hold the old one).
if [ -f .dev-secrets ]; then
  bun scripts/seed-dev-user.ts                                    # .dev-secrets -> scripts/seed-dev-user.sql (also grandfathers vault "demo")
  # The seed goes through `--command`, NOT `--file`: wrangler sends a remote
  # `--file` to D1's /import API (init -> R2 upload -> ingest), which the scoped
  # deploy key refuses (401 "Authentication error [code: 10000]", T-413 staging
  # train). `--command` uses D1's /query API, the same path `d1 migrations apply`
  # just used above with the same key (wrangler sends each migration file's full
  # text as one command). The SQL is the file's bytes, unchanged; it is two small
  # statements, far below any argv limit.
  SEED_SQL="$(cat ./scripts/seed-dev-user.sql)"
  bunx wrangler d1 execute parachute-identity-staging --remote --env staging --command="$SEED_SQL"
  unset SEED_SQL
else
  echo "no workers/identity/.dev-secrets: the staging dev user is left as it is"
fi

# --- propagation guard (cloud#174 fix, the rc.92 incident) -------------------
# `wrangler deploy` returning success means the upload was ACCEPTED — it does
# NOT mean every edge PoP is already serving it. The rc.92 auth-Wave-1 deploy
# hit this for real: the deploy-staging.yml smoke ran ~18s after "Deployed
# ... triggers" and still landed on the OLD worker version (a brand-new route
# 404ing, a brand-new response header simply absent) — indistinguishable from
# a code bug until you check the timestamps. `/health`'s `version` field
# (env.CF_VERSION_METADATA.id, wired identity-side) is the ground truth for
# "which version is THIS PoP actually running" — poll it until it changes
# from the pre-deploy baseline before ever invoking smoke.
identity_health_version() {
  curl -sf "${IDENTITY_STAGING}/health" 2>/dev/null | grep -o '"version":"[^"]*"' | sed -e 's/"version":"//' -e 's/"$//'
}
BASELINE_VERSION="$(identity_health_version || true)"

# ISSUER + VAULT_ORIGIN are baked into [env.staging.vars] (self-contained).
bunx wrangler deploy --env staging

echo "Waiting for the new version to actually propagate to the edge before smoke..."
DEPLOY_WAIT_SECS=90
DEPLOY_POLL_INTERVAL=3
elapsed=0
NEW_VERSION=""
while [ "$elapsed" -lt "$DEPLOY_WAIT_SECS" ]; do
  NEW_VERSION="$(identity_health_version || true)"
  if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "$BASELINE_VERSION" ]; then
    echo "New version live: ${NEW_VERSION} (was: ${BASELINE_VERSION:-<none>}) after ${elapsed}s"
    break
  fi
  sleep "$DEPLOY_POLL_INTERVAL"
  elapsed=$((elapsed + DEPLOY_POLL_INTERVAL))
done
if [ -z "$NEW_VERSION" ] || [ "$NEW_VERSION" == "$BASELINE_VERSION" ]; then
  echo "ERROR: /health on ${IDENTITY_STAGING} still reports the PRE-deploy version" \
       "(${NEW_VERSION:-<none>}, baseline ${BASELINE_VERSION:-<none>}) after ${DEPLOY_WAIT_SECS}s." \
       "Refusing to run smoke against a possibly-stale edge — re-run once propagation catches up." >&2
  exit 1
fi

echo
echo "Staging deployed."
echo "  Console:  ${IDENTITY_STAGING}/console"
echo "  Vaults:   ${VAULT_STAGING}/vault/<name>/..."
echo "Smoke it:  bun scripts/smoke-staging.ts"
