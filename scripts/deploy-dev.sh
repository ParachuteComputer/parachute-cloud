#!/usr/bin/env bash
#
# deploy-dev.sh — reproducible deploy of the two Vault Cloud workers to the
# **Unforced Development** Cloudflare account (workers.dev + PATH routing, Phase
# 5a). Idempotent: safe to re-run. Provisioning (D1 + R2) is one-time — see the
# commented block below; the ids are already committed in the wrangler.toml files.
#
# The u.parachute.computer wildcard-subdomain domain comes with the real
# parachute.computer account (later) — tonight everything routes by path
# (/vault/<name>/*), so the deployed vars keep VAULT_BASE_DOMAIN as the prod
# default but the vault is reached at <VAULT_URL>/vault/<name>/...
#
# After deploying:  bun scripts/smoke-dev.ts
set -euo pipefail

export CLOUDFLARE_ACCOUNT_ID=8f2a7eb9d5e21ffa902a76cf62975c82   # "Unforced Development"

# The workers.dev URLs are deterministic once the account subdomain (`unforced`)
# is known. A brand-new account learns it from the first `wrangler deploy` output;
# after that these are fixed. Both are also the smoke script's defaults.
IDENTITY_URL="https://parachute-identity.unforced.workers.dev"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- one-time provisioning (uncomment on a fresh account) --------------------
#   bunx wrangler d1 create parachute-cloud-identity   # -> database_name parachute-identity;
#                                                       #    put the printed id in workers/identity/wrangler.toml
#   bunx wrangler r2 bucket create parachute-vault-dev
#
# NOTE: the stored wrangler OAuth token DID carry d1 + r2 write scope, so no
# interactive re-auth was needed. If a future token lacks them, run an
# interactive `bunx wrangler login` (grants d1 + r2) before provisioning.

# --- identity worker (OAuth issuer on D1) -----------------------------------
cd "$ROOT/workers/identity"
bunx wrangler d1 migrations apply parachute-identity --remote
bun scripts/seed-dev-user.ts                                    # .dev-secrets -> scripts/seed-dev-user.sql
bunx wrangler d1 execute parachute-identity --remote --file=./scripts/seed-dev-user.sql
# ISSUER must equal the worker's own origin (a cloud vault has no hub); the toml
# keeps the prod default that the conformance corpus pins, so override here.
bunx wrangler deploy --var "ISSUER:${IDENTITY_URL}"

# --- vault DO worker (DO SQLite + R2 + scope-guard against identity) ---------
cd "$ROOT/workers/vault"
# DO SQLite migration (new_sqlite_classes) applies automatically on deploy.
bunx wrangler deploy --var "ISSUER_ORIGIN:${IDENTITY_URL}"

echo
echo "Deployed. Smoke it:  bun scripts/smoke-dev.ts"
