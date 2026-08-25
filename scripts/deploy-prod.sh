#!/usr/bin/env bash
#
# deploy-prod.sh — deploy of the two Vault Cloud workers to PRODUCTION: the
# TOP-LEVEL config in both wrangler.toml files (NOT a named env — named envs
# auto-suffix worker names, which would detach the custom domains from the
# workers that hold them; see the ENVIRONMENTS banner in each wrangler.toml).
# Idempotent: safe to re-run.
#
# PRODUCTION SHAPE (since 2026-07-02, the production/staging split):
#   - branded Custom Domains (zone parachute.computer, in this account):
#       console + OAuth issuer:  https://cloud.parachute.computer  (parachute-identity)
#       vaults (path routing):   https://u.parachute.computer/vault/<name>/...  (parachute-vault-do)
#     workers.dev URLs still resolve as a fallback.
#   - ENVIRONMENT="production": the `x-parachute-dev-magic-link` echo header is
#     NEVER emitted, and magic-link email is REAL (send_email binding + the
#     onboarded parachute.computer Email Sending zone).
#   - migrations run against the production D1 (parachute-identity). NO dev-user
#     seeding here: `dev@parachute.computer` (owner of the grandfathered `demo`
#     vault) already exists in the production D1 from the pre-split dev era and
#     is RETAINED as the operator login for now. REVISIT BEFORE PUBLIC LAUNCH:
#     decide whether the operator account keeps a password login, gets rotated,
#     or moves to a dedicated ops identity. Never re-seed it from here — the
#     seed's INSERT OR REPLACE would rotate the live operator credentials as a
#     deploy side effect.
#
# After deploying:  bun scripts/smoke-prod.ts   (READ-ONLY checks — the full
# account/vault-creating smoke belongs on staging: scripts/smoke-staging.ts)
set -euo pipefail

export CLOUDFLARE_ACCOUNT_ID=d5d7c8646c3b69ce9f16bfd12ecbe98a   # new Parachute account

ISSUER_ORIGIN="https://cloud.parachute.computer"   # console + OAuth issuer (iss)
VAULT_PUBLIC="https://u.parachute.computer"        # vault host (path routing)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Verify the exact pinned vault-core commit (cloud#45, cloud#59) and the
# shared Hub contract before the workspace install snapshots either file:
# dependency into node_modules. This is the local-deploy close for cloud#59:
# without it, a developer's sibling parachute-vault checkout on some other
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
# the exact commit in scripts/spa-source.env; build-spa.sh verifies and builds it
# at the origin root before the identity deploy below.
bash "$ROOT/scripts/build-spa.sh"

# --- identity worker (OAuth issuer on the production D1) ---------------------
# `--env=""` targets the TOP-LEVEL (production) config explicitly, so wrangler
# doesn't warn that [env.staging] also exists.
cd "$ROOT/workers/identity"
bunx wrangler d1 migrations apply parachute-identity --remote --env=""
# NO seed step (see the header: the operator login already exists in prod).

# Capture the PRE-deploy edge version so the propagation gate at the bottom of
# this script has a baseline to poll away from (cloud#183). Must be read BEFORE
# the deploy — after it, "unchanged" and "not yet propagated" are the same
# string. `|| true` so a transient /health blip doesn't abort the deploy; an
# empty baseline just means the poll accepts any non-empty version.
identity_health_version() {
  curl -sf "${ISSUER_ORIGIN}/health" 2>/dev/null | grep -o '"version":"[^"]*"' | sed -e 's/"version":"//' -e 's/"$//'
}
BASELINE_VERSION="$(identity_health_version || true)"
echo "Pre-deploy edge version at ${ISSUER_ORIGIN}: ${BASELINE_VERSION:-<none>}"

# ISSUER + VAULT_ORIGIN are baked into the top-level [vars] (self-contained).
bunx wrangler deploy --env=""

# --- vault DO worker (DO SQLite + R2 + scope-guard against identity) ---------
cd "$ROOT/workers/vault"
# DO SQLite migration (new_sqlite_classes) applies automatically on deploy.
# ISSUER_ORIGIN (baked into [vars]) must match the identity issuer so token
# `iss` + JWKS validate.
bunx wrangler deploy --env=""

# --- propagation guard (cloud#183 — staging's cloud#174 fix, ported) ---------
# `wrangler deploy` returning success means the upload was ACCEPTED — it does
# NOT mean every edge PoP is already serving it. deploy-prod.sh was deliberately
# left ungated on the reasoning that production is manual-approval-gated and so
# under less time pressure. But the approval gate slows the DISPATCH→DEPLOY gap,
# not the DEPLOY→SMOKE gap, and the race lives in the latter: the rc.96-98 prod
# deploy (run 29584725832) went red on ONE smoke step — the tickets uniform-404
# check saw a bare 404 with no error envelope — because it hit a PoP still
# serving the pre-tickets worker seconds after wrangler reported success. A live
# probe minutes later returned the correct enveloped 404. And a red prod run
# reads as a FAILED DEPLOY to the operator who just clicked approve, which is
# the real cost.
#
# `/health`'s `version` field (env.CF_VERSION_METADATA.id, wired identity-side —
# see [version_metadata] in workers/identity/wrangler.toml) is the ground truth
# for "which version is THIS PoP actually running". Poll it until it moves off
# the pre-deploy baseline before handing off to smoke-prod.ts. Runs AFTER both
# worker deploys so the vault deploy's own duration counts toward propagation.
echo
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
  echo "ERROR: /health on ${ISSUER_ORIGIN} still reports the PRE-deploy version" \
       "(${NEW_VERSION:-<none>}, baseline ${BASELINE_VERSION:-<none>}) after ${DEPLOY_WAIT_SECS}s." >&2
  echo "       THE DEPLOY ITSELF SUCCEEDED — both workers uploaded and were accepted." \
       "What failed is the propagation check: this PoP has not picked the new version up yet," \
       "and smoking a stale edge produces false reds that read as a broken deploy." \
       "Re-run the smoke (bun scripts/smoke-prod.ts) once propagation catches up." >&2
  exit 1
fi

echo
echo "Production deployed."
echo "  Console:  ${ISSUER_ORIGIN}/console"
echo "  Vaults:   ${VAULT_PUBLIC}/vault/<name>/..."
echo "Smoke it:  bun scripts/smoke-prod.ts   (read-only)"
