#!/usr/bin/env bash
# door-parity.sh: hold this door to the same contracts as a box (T-431).
#
# Fetches parachute-core's door contracts at the commit pinned in scripts/door-suite-source.env, starts this
# checkout's two workers under local workerd inside the contracts' own sandbox (one private loopback, no network),
# runs every contract against them, and compares what an app could see with the box's kept fingerprint. Exit 0 only
# when every contract passes and every difference from the box is one named in the pinned deliberate.json.
#
# Needs: this checkout installed (`bun install` after the two materialize scripts), Node, and on Linux `unshare`,
# `ip` and `nft`. Results: $DOOR_RESULTS (default .door-parity/) with MATRIX.md, COMPARE.md and the door's output.
#   DOOR_SUITE_DIR=<a parachute-core checkout>   use it as it is (to try a suite change before it is pinned)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=door-suite-source.env
source "$ROOT/scripts/door-suite-source.env"
SUITE="${DOOR_SUITE_DIR:-$ROOT/../parachute-core-doors}"
RESULTS="${DOOR_RESULTS:-$ROOT/.door-parity}"

if [ -z "${DOOR_SUITE_DIR:-}" ]; then
  if ! git -C "$SUITE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    mkdir -p "$SUITE"
    git init -q "$SUITE"
    git -C "$SUITE" remote add origin "$DOOR_SUITE_REPO_URL"
  fi
  if [ "$(git -C "$SUITE" rev-parse HEAD 2>/dev/null || true)" != "$DOOR_SUITE_REF" ]; then
    git -C "$SUITE" fetch -q --depth 1 origin "$DOOR_SUITE_REF"
    git -C "$SUITE" checkout -q --detach FETCH_HEAD
  fi
  if [ -n "$(git -C "$SUITE" status --porcelain -- contracts)" ]; then
    echo "error: the pinned door suite at $SUITE has local changes" >&2
    exit 1
  fi
  echo "door suite: parachute-core $(git -C "$SUITE" rev-parse --short HEAD) (pinned)"
else
  echo "door suite: $SUITE as it is (NOT PINNED)"
fi
for w in identity vault; do
  [ -f "$ROOT/workers/$w/node_modules/wrangler/bin/wrangler.js" ] || { echo "error: workers/$w has no wrangler: run bun install first" >&2; exit 1; }
done

mkdir -p "$RESULTS"
cd "$SUITE/contracts"
bun install --frozen-lockfile >/dev/null
# The sandbox has its own /tmp; a TMPDIR under the home it hides would not exist inside.
env -u TMPDIR CLOUD_REPO="$ROOT" DOOR_RESULTS="$RESULTS" bun run doors -- --doors cloud --with-golden "$DOOR_SUITE_GOLDEN"
