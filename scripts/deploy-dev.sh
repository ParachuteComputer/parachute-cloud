#!/usr/bin/env bash
#
# deploy-dev.sh — reproducible deploy of the two Vault Cloud workers to the
# **Unforced Development** Cloudflare account. Idempotent: safe to re-run.
# Provisioning (D1 + R2) is one-time — see the commented block below; the ids
# are already committed in the wrangler.toml files.
#
# BRANDED DOMAINS (live since 2026-07-02): the parachute.computer zone is in THIS
# account, so both workers front on Custom Domains:
#   - console + OAuth issuer:  https://cloud.parachute.computer  (parachute-identity)
#   - vaults (path routing):   https://u.parachute.computer/vault/<name>/...  (parachute-vault-do)
# The issuer origin is cloud.parachute.computer, so tokens carry
# iss=https://cloud.parachute.computer and the vault trusts that origin. Per-vault
# subdomains (<name>.u.parachute.computer) need proxied wildcard DNS (Enterprise +
# a dns-edit token) — see TRYIT for the enable-later steps. workers.dev URLs still
# resolve as a fallback.
#
# After deploying:  bun scripts/smoke-dev.ts
set -euo pipefail

export CLOUDFLARE_ACCOUNT_ID=8f2a7eb9d5e21ffa902a76cf62975c82   # "Unforced Development"

# The branded origins the deploy pins into the workers' env.
ISSUER_ORIGIN="https://cloud.parachute.computer"   # console + OAuth issuer (iss)
VAULT_PUBLIC="https://u.parachute.computer"         # vault host (path routing)

ROOT_EARLY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Refresh the copied file: dep FIRST — bun snapshots @openparachute/core into
# node_modules at install time, so a vault-core change upstream is INVISIBLE to
# builds until re-installed (bit us 2026-07-02: stale txn.ts tested green,
# deployed stale). One bun install makes every deploy build against current core.
(cd "$ROOT_EARLY" && bun install)

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
bun scripts/seed-dev-user.ts                                    # .dev-secrets -> scripts/seed-dev-user.sql (also grandfathers vault "demo")
bunx wrangler d1 execute parachute-identity --remote --file=./scripts/seed-dev-user.sql
# ISSUER = the branded issuer origin (a cloud vault has no hub; iss must equal a
# real, reachable origin). The toml keeps id.parachute.computer as the default the
# conformance corpus pins, so override here. VAULT_ORIGIN puts the console's
# connect cards + services catalog on the branded vault host (path routing).
bunx wrangler deploy --var "ISSUER:${ISSUER_ORIGIN}" --var "VAULT_ORIGIN:${VAULT_PUBLIC}"

# --- vault DO worker (DO SQLite + R2 + scope-guard against identity) ---------
cd "$ROOT/workers/vault"
# DO SQLite migration (new_sqlite_classes) applies automatically on deploy.
# ISSUER_ORIGIN must match the identity issuer so token `iss` + JWKS validate.
bunx wrangler deploy --var "ISSUER_ORIGIN:${ISSUER_ORIGIN}"

echo
echo "Deployed."
echo "  Console:  ${ISSUER_ORIGIN}/console"
echo "  Vaults:   ${VAULT_PUBLIC}/vault/<name>/..."
echo "Smoke it:  bun scripts/smoke-dev.ts"
