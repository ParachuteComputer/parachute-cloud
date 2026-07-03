#!/usr/bin/env bash
#
# deploy-staging.sh — reproducible deploy of the two Vault Cloud workers to the
# STAGING environment ([env.staging] in both wrangler.toml files). Idempotent:
# safe to re-run. Provisioning (staging D1 + R2) is one-time — see the commented
# block below; the ids are already committed in the wrangler.toml files.
#
# STAGING SHAPE (since 2026-07-02, the production/staging split):
#   - workers.dev URLs ONLY (no custom domains — those belong to production):
#       console + OAuth issuer:  https://parachute-identity-staging.unforced.workers.dev
#       vaults (path routing):   https://parachute-vault-do-staging.unforced.workers.dev/vault/<name>/...
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

export CLOUDFLARE_ACCOUNT_ID=8f2a7eb9d5e21ffa902a76cf62975c82   # "Unforced Development"

IDENTITY_STAGING="https://parachute-identity-staging.unforced.workers.dev"
VAULT_STAGING="https://parachute-vault-do-staging.unforced.workers.dev"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Refresh the copied file: dep FIRST — bun snapshots @openparachute/core into
# node_modules at install time, so a vault-core change upstream is INVISIBLE to
# builds until re-installed (bit us 2026-07-02: stale txn.ts tested green,
# deployed stale). One bun install makes every deploy build against current core.
(cd "$ROOT" && bun install)

# --- one-time provisioning (already done 2026-07-02; kept for a fresh account) --
#   bunx wrangler d1 create parachute-identity-staging   # -> id into [env.staging.d1_databases]
#                                                        #    in workers/identity/wrangler.toml
#   bunx wrangler r2 bucket create parachute-vault-staging
#
# NOTE: the stored wrangler OAuth token carries d1 + r2 write scope. If a future
# token lacks them, run an interactive `bunx wrangler login` before provisioning.

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
bun scripts/seed-dev-user.ts                                    # .dev-secrets -> scripts/seed-dev-user.sql (also grandfathers vault "demo")
bunx wrangler d1 execute parachute-identity-staging --remote --env staging --file=./scripts/seed-dev-user.sql
# ISSUER + VAULT_ORIGIN are baked into [env.staging.vars] (self-contained).
bunx wrangler deploy --env staging

echo
echo "Staging deployed."
echo "  Console:  ${IDENTITY_STAGING}/console"
echo "  Vaults:   ${VAULT_STAGING}/vault/<name>/..."
echo "Smoke it:  bun scripts/smoke-staging.ts"
