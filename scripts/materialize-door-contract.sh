#!/usr/bin/env bash
# Materialize the exact Hub door-contract source used by Cloud CI and deploys.
# Existing developer checkouts are verified but never switched or reset.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="${DOOR_CONTRACT_SOURCE_FILE:-$ROOT/scripts/door-contract-source.env}"
# shellcheck source=door-contract-source.env
source "$SOURCE_FILE"

HUB_REPO="${PARACHUTE_HUB_REPO:-$ROOT/../parachute-hub}"
HUB_REMOTE="${PARACHUTE_HUB_REMOTE:-https://github.com/ParachuteComputer/parachute-hub.git}"
PACKAGE_DIR="$HUB_REPO/packages/door-contract"

if ! git -C "$HUB_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -e "$HUB_REPO" ] && [ ! -d "$HUB_REPO" ]; then
    echo "error: PARACHUTE_HUB_REPO is not a directory: $HUB_REPO" >&2
    exit 1
  fi
  if [ -d "$HUB_REPO" ] && [ -n "$(find "$HUB_REPO" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "error: PARACHUTE_HUB_REPO is a non-Git, nonempty directory: $HUB_REPO" >&2
    exit 1
  fi
  mkdir -p "$HUB_REPO"
  git init "$HUB_REPO"
  git -C "$HUB_REPO" remote add origin "$HUB_REMOTE"
  git -C "$HUB_REPO" fetch --depth 1 origin "$DOOR_CONTRACT_HUB_REF"
  git -C "$HUB_REPO" checkout --detach FETCH_HEAD
fi

actual_ref="$(git -C "$HUB_REPO" rev-parse HEAD)"
if [ "$actual_ref" != "$DOOR_CONTRACT_HUB_REF" ]; then
  cat >&2 <<EOF
error: Hub checkout is not the pinned door-contract source.
  expected: $DOOR_CONTRACT_HUB_REF
  actual:   $actual_ref
  path:     $HUB_REPO
Use PARACHUTE_HUB_REPO to point at a clean checkout of the pinned commit.
EOF
  exit 1
fi

if [ -n "$(git -C "$HUB_REPO" status --porcelain -- packages/door-contract tsconfig.json)" ]; then
  echo "error: pinned Hub door-contract build inputs have local modifications: $HUB_REPO" >&2
  git -C "$HUB_REPO" status --short -- packages/door-contract tsconfig.json >&2
  exit 1
fi

if [ ! -f "$PACKAGE_DIR/package.json" ]; then
  echo "error: pinned Hub checkout has no door-contract package: $PACKAGE_DIR" >&2
  exit 1
fi
actual_version="$(bun -e 'const p = await Bun.file(process.argv[1]).json(); process.stdout.write(String(p.version ?? ""));' "$PACKAGE_DIR/package.json")"
if [ "$actual_version" != "$DOOR_CONTRACT_VERSION" ]; then
  echo "error: door-contract version mismatch: expected $DOOR_CONTRACT_VERSION, got $actual_version" >&2
  exit 1
fi

rm -rf "$PACKAGE_DIR/dist"
(
  cd "$PACKAGE_DIR"
  bunx --package=typescript@5.6.3 tsc
)

echo "door-contract v$actual_version @ $actual_ref ($PACKAGE_DIR)"
