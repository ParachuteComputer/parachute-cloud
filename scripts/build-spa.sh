#!/usr/bin/env bash
#
# Build the app bundle served by the Cloud identity worker through Workers
# Static Assets. The identity worker owns the Cloud/account/OAuth ceremonies and
# serves this browser application on my.parachute.computer; Vault data remains
# in the separate vault worker.
#
# The app source is pinned in spa-source.env: its repository, package name,
# version and commit. Deployment workflows fetch that exact commit into a
# sibling checkout named after the repository, and this script verifies the
# package and version before building. This keeps the frontend embedded in any
# Cloud release reproducible instead of silently following another repository's
# branch. Which app it is, is the pin's to say: the older hosted app
# (parachute-app, bun) or the Parachute app's web build (parachute, npm).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=spa-source.env
source "${SPA_SOURCE_FILE:-$ROOT/scripts/spa-source.env}"

DEST="${SPA_DEST:-$ROOT/workers/identity/dist-assets}"
APP_REPO="${APP_REPO:-$ROOT/../${SPA_APP_REPO##*/}}"

if [[ ! -f "$APP_REPO/package.json" ]]; then
  echo "build-spa: ${SPA_APP_REPO##*/} checkout not found at $APP_REPO" >&2
  echo "           set APP_REPO=/path/to/${SPA_APP_REPO##*/} (a sibling checkout of $SPA_APP_REPO)." >&2
  exit 1
fi

ACTUAL_NAME="$(cd "$APP_REPO" && node -p "require('./package.json').name" 2>/dev/null || true)"
if [[ "$ACTUAL_NAME" != "$SPA_APP_NAME" ]]; then
  echo "build-spa: expected $SPA_APP_NAME at $APP_REPO, found ${ACTUAL_NAME:-<unknown>}." >&2
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

# Both apps are root-hosted: deep links and /oauth/callback require absolute
# /assets/... references and a root router basename. The checkout's own lockfile
# says how it is built: bun.lock (the older app, with its explicit root signal)
# or package-lock.json (the Parachute app, whose web build is root-based).
echo "build-spa: building $SPA_APP_NAME v$ACTUAL_VERSION ($SPA_APP_REF) at origin root…"
cd "$APP_REPO"
if [[ -f bun.lock || -f bun.lockb ]]; then
  bun install --frozen-lockfile
  VITE_BASE_PATH="/" bun run build
elif [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
  npm run build
else
  echo "build-spa: $APP_REPO has no lockfile (bun.lock or package-lock.json); refusing a build that isn't pinned." >&2
  exit 1
fi
if [[ ! -f "$APP_REPO/dist/index.html" ]]; then
  echo "build-spa: the build left no dist/index.html in $APP_REPO." >&2
  exit 1
fi

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
# emit the SPA-specific CSP: for the older app from the actual index.html theme
# script hash; for an app that says what it asks of a host (dist/hosted.json),
# Cloud's policy for it, refused unless it is exactly what that build asks.
echo "build-spa: emitting dist-assets/_headers (SPA Content-Security-Policy)…"
bun "$ROOT/scripts/gen-spa-headers.ts" "$DEST"

echo "build-spa: wrote $(find "$DEST" -type f | wc -l | tr -d ' ') files to $DEST."
