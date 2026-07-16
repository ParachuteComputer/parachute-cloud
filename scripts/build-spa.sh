#!/usr/bin/env bash
#
# Build the Parachute App bundle served by the Cloud identity worker through
# Workers Static Assets. The identity worker owns the Cloud/account/OAuth
# ceremonies and serves this browser application on app.parachute.computer;
# Vault data remains in the separate vault worker at u.parachute.computer.
#
# The App source is pinned in spa-source.env. Deployment workflows fetch that
# exact commit into a sibling checkout, and this script verifies its package
# version before building. This keeps the frontend embedded in any Cloud release
# reproducible instead of silently following another repository's main branch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=spa-source.env
source "$ROOT/scripts/spa-source.env"

DEST="${SPA_DEST:-$ROOT/workers/identity/dist-assets}"
APP_REPO="${APP_REPO:-$ROOT/../parachute-app}"

if [[ ! -f "$APP_REPO/package.json" ]]; then
  echo "build-spa: parachute-app checkout not found at $APP_REPO" >&2
  echo "           set APP_REPO=/path/to/parachute-app (a sibling checkout)." >&2
  exit 1
fi

ACTUAL_NAME="$(cd "$APP_REPO" && node -p "require('./package.json').name" 2>/dev/null || true)"
if [[ "$ACTUAL_NAME" != "@openparachute/parachute-app" ]]; then
  echo "build-spa: expected @openparachute/parachute-app at $APP_REPO, found ${ACTUAL_NAME:-<unknown>}." >&2
  exit 1
fi

ACTUAL_VERSION="$(cd "$APP_REPO" && node -p "require('./package.json').version" 2>/dev/null || true)"
if [[ "$ACTUAL_VERSION" != "$SPA_APP_VERSION" ]]; then
  echo "build-spa: App version mismatch — pinned $SPA_APP_VERSION, checkout has ${ACTUAL_VERSION:-<unknown>}." >&2
  echo "           fetch SPA_APP_REF=$SPA_APP_REF from scripts/spa-source.env." >&2
  exit 1
fi

ACTUAL_REF="$(cd "$APP_REPO" && git rev-parse HEAD 2>/dev/null || true)"
if [[ "$ACTUAL_REF" != "$SPA_APP_REF" ]]; then
  echo "build-spa: App source mismatch — pinned $SPA_APP_REF, checkout has ${ACTUAL_REF:-<no git revision>}." >&2
  exit 1
fi
if [[ -n "$(cd "$APP_REPO" && git status --porcelain)" ]]; then
  echo "build-spa: App checkout has tracked or untracked local modifications; refusing a non-reproducible bundle." >&2
  exit 1
fi

# The App is root-hosted by default, but keep the explicit build signal because
# deep links and /oauth/callback require absolute /assets/... references and a
# root React Router basename.
echo "build-spa: building @openparachute/parachute-app v$ACTUAL_VERSION ($SPA_APP_REF) at origin root…"
cd "$APP_REPO"
bun install --frozen-lockfile
VITE_BASE_PATH="/" bun run build

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$APP_REPO/dist/." "$DEST/"
# Pages-era artifacts ride in from the app's public/: CNAME (GitHub Pages) and
# _redirects (Cloudflare Pages SPA fallback). The identity worker does its own
# SPA fallback (not_found_handling = single-page-application), and wrangler
# HARD-REJECTS the Pages-style _redirects rule at deploy time ("Infinite loop
# detected", code 100324 — cloud#156, first real CI deploy 2026-07-16). Strip both.
rm -f "$DEST/CNAME" "$DEST/_redirects"

# Static Assets bypasses the identity worker's server-rendered HTML helper, so
# emit the SPA-specific CSP from the actual index.html theme script hash.
echo "build-spa: emitting dist-assets/_headers (SPA Content-Security-Policy)…"
bun "$ROOT/scripts/gen-spa-headers.ts" "$DEST"

echo "build-spa: wrote $(find "$DEST" -type f | wc -l | tr -d ' ') files to $DEST."
