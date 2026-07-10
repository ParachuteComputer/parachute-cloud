#!/usr/bin/env bash
#
# build-spa.sh — produce the notes-ui SPA bundle the identity worker serves via
# Workers Static Assets (P1.1, parachute-cloud#116), into
# workers/identity/dist-assets/ (the [assets].directory). Both deploy scripts run
# this BEFORE `wrangler deploy` so the assets dir exists at deploy time; it is
# gitignored (generated) and reproducible from the pin below.
#
# ── WHY BUILD FROM SOURCE, not the npm dist (the P1.1 correction) ──────────────
# The plan's first instinct was "copy the published @openparachute/notes-ui dist."
# That does NOT work for serving at ORIGIN ROOT, and the reasons are load-bearing:
#
#   1. The npm-published dist is the BUNDLED-HOST shape: `base: ""` → RELATIVE
#      asset refs (`./assets/...`). Served at origin root, a deep link like
#      `/some-note` (or the /oauth/callback PKCE return) resolves `./assets/x`
#      against the request path → `/some-note/assets/x` → 404 → the SPA can't
#      boot. Origin-root serving needs ABSOLUTE `/assets/...` (base "/").
#   2. The React Router basename for origin root comes ONLY from the build-time
#      `VITE_BASE_PATH=/` signal (base-url.ts STANDALONE_DEPLOY). getMountBase
#      REJECTS a bare "/" meta tag (surface-client mount.ts), so no post-process
#      of a prebuilt dist can produce the root basename — it must be BUILT with
#      VITE_BASE_PATH=/. Without it the router falls back to `/notes` and blanks.
#   3. The version the app campaign pins (0.1.23, the P0.3 ceremony-denylist SW
#      + surface#189's bare-path fix) is NOT published to npm anyway (npm latest
#      is 0.1.15) — it lives only in the sibling checkout.
#
# So we build the SAME artifact notes.parachute.computer already serves (the
# standalone VITE_BASE_PATH=/ build), from the sibling parachute-surface checkout,
# pinned to an exact version. This IS the [PLAN-DECISION] "the worker pins which
# version it serves" — just built, not copied.
#
# 0.1.23 also carries surface#189 (the bare-path note route no longer collides
# with a ceremony prefix) — the companion fix that makes same-origin SPA + this
# run_worker_first guard safe once app. is live.
#
# ── TO BUMP THE SERVED APP ─────────────────────────────────────────────────────
#   1. Bump SPA_NOTES_UI_VERSION below to the target notes-ui version.
#   2. Make sure the parachute-surface checkout is AT that version (its main HEAD,
#      or ideally a release tag `notes-ui-v<version>`; CI checks out that ref).
#      The guard below FAILS the build on any mismatch so the served app is always
#      the intended, deterministic one — the sibling monorepo bumps notes-ui per
#      PR, so a stale/ahead checkout is caught rather than silently served.
#   • Escape hatch for a staging soak against a drifted checkout: run with
#     SPA_ALLOW_VERSION_DRIFT=1 to WARN-and-build the checkout's actual version
#     instead of failing (the built + announced version is still explicit).
set -euo pipefail

# The pinned notes-ui version this worker serves. Exact (no caret) — deterministic.
SPA_NOTES_UI_VERSION="0.1.23"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/workers/identity/dist-assets"
# The sibling parachute-surface checkout (override with SURFACE_REPO if it lives
# elsewhere — e.g. a CI clone path).
SURFACE_REPO="${SURFACE_REPO:-$ROOT/../parachute-surface}"
NOTES_UI="$SURFACE_REPO/packages/notes-ui"

if [[ ! -d "$NOTES_UI" ]]; then
  echo "build-spa: parachute-surface checkout not found at $SURFACE_REPO" >&2
  echo "           set SURFACE_REPO=/path/to/parachute-surface (a sibling checkout)." >&2
  exit 1
fi

# Version guard — the served app must be the pinned version, or fail loudly
# (unless SPA_ALLOW_VERSION_DRIFT=1, which downgrades the mismatch to a warning).
ACTUAL="$(cd "$NOTES_UI" && node -p "require('./package.json').version" 2>/dev/null || true)"
if [[ "$ACTUAL" != "$SPA_NOTES_UI_VERSION" ]]; then
  if [[ "${SPA_ALLOW_VERSION_DRIFT:-}" == "1" ]]; then
    echo "build-spa: WARNING — pinned $SPA_NOTES_UI_VERSION but checkout has ${ACTUAL:-<unknown>}; building the checkout's version (SPA_ALLOW_VERSION_DRIFT=1)." >&2
  else
    echo "build-spa: notes-ui version mismatch — pinned $SPA_NOTES_UI_VERSION, checkout has ${ACTUAL:-<unknown>}." >&2
    echo "           check out parachute-surface at notes-ui v$SPA_NOTES_UI_VERSION (tag notes-ui-v$SPA_NOTES_UI_VERSION)," >&2
    echo "           update SPA_NOTES_UI_VERSION in this script to a deliberate bump," >&2
    echo "           or re-run with SPA_ALLOW_VERSION_DRIFT=1 to build the checkout's version anyway." >&2
    exit 1
  fi
fi

echo "build-spa: building @openparachute/notes-ui v${ACTUAL:-$SPA_NOTES_UI_VERSION} at origin root (VITE_BASE_PATH=/)…"
cd "$SURFACE_REPO"
bun install
# surface-client is a workspace dep of notes-ui — build it first (mirrors
# deploy-notes-ui.yml, the standalone notes.parachute.computer pipeline).
bun run --filter "@openparachute/surface-client" build
# The origin-root build: VITE_BASE_PATH=/ → absolute /assets/... + STANDALONE_DEPLOY
# (basename ""). The identical artifact notes.parachute.computer serves today.
VITE_BASE_PATH="/" bun run --filter "@openparachute/notes-ui" build

# Publish into the worker's assets dir (clean first so removed files don't linger).
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$NOTES_UI/dist/." "$DEST/"
# CNAME is a GitHub Pages artifact (the notes. custom domain) — meaningless for
# the worker and would just be served as a stray /CNAME asset. Drop it.
rm -f "$DEST/CNAME"

# Emit the SPA Content-Security-Policy _headers file (P1.1.5) from the ACTUAL
# built index.html — the inline theme-script hash is derived here so it can never
# drift from what's served (Cloudflare treats a root `_headers` file as config,
# not a served asset). See scripts/gen-spa-headers.ts + workers/identity/src/spa-csp.ts.
echo "build-spa: emitting dist-assets/_headers (SPA Content-Security-Policy)…"
bun "$ROOT/scripts/gen-spa-headers.ts" "$DEST"

echo "build-spa: wrote $(find "$DEST" -type f | wc -l | tr -d ' ') files to workers/identity/dist-assets (index.html + assets/ + sw.js + manifest + _headers)."
