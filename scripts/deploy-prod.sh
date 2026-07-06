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
# Refresh the copied file: dep FIRST — bun snapshots @openparachute/core into
# node_modules at install time, so a vault-core change upstream is INVISIBLE to
# builds until re-installed (bit us 2026-07-02: stale txn.ts tested green,
# deployed stale). One bun install makes every deploy build against current core.
(cd "$ROOT" && bun install)

# --- identity worker (OAuth issuer on the production D1) ---------------------
# `--env=""` targets the TOP-LEVEL (production) config explicitly, so wrangler
# doesn't warn that [env.staging] also exists.
cd "$ROOT/workers/identity"
bunx wrangler d1 migrations apply parachute-identity --remote --env=""
# NO seed step (see the header: the operator login already exists in prod).
# ISSUER + VAULT_ORIGIN are baked into the top-level [vars] (self-contained).
bunx wrangler deploy --env=""

# --- vault DO worker (DO SQLite + R2 + scope-guard against identity) ---------
cd "$ROOT/workers/vault"
# DO SQLite migration (new_sqlite_classes) applies automatically on deploy.
# ISSUER_ORIGIN (baked into [vars]) must match the identity issuer so token
# `iss` + JWKS validate.
bunx wrangler deploy --env=""

echo
echo "Production deployed."
echo "  Console:  ${ISSUER_ORIGIN}/console"
echo "  Vaults:   ${VAULT_PUBLIC}/vault/<name>/..."
echo "Smoke it:  bun scripts/smoke-prod.ts   (read-only)"
