#!/usr/bin/env bash
# Materialize the exact parachute-core source whose engine package
# (packages/vault/core, npm name @openparachute/core) Cloud CI and deploys build
# against. workers/vault depends on it via
# file:../../../parachute-core/packages/vault/core, so the checkout lives next to
# this repo at ../parachute-core.
# Existing developer checkouts are verified but never switched or reset.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="${CORE_SOURCE_FILE:-$ROOT/scripts/core-source.env}"
# shellcheck source=core-source.env
source "$SOURCE_FILE"

CORE_REPO="${PARACHUTE_CORE_REPO:-$ROOT/../parachute-core}"
CORE_REMOTE="${PARACHUTE_CORE_REMOTE:-$PARACHUTE_CORE_REPO_URL}"
PACKAGE_DIR="$CORE_REPO/$CORE_ENGINE_DIR"

if ! git -C "$CORE_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -e "$CORE_REPO" ] && [ ! -d "$CORE_REPO" ]; then
    echo "error: PARACHUTE_CORE_REPO is not a directory: $CORE_REPO" >&2
    exit 1
  fi
  if [ -d "$CORE_REPO" ] && [ -n "$(find "$CORE_REPO" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "error: PARACHUTE_CORE_REPO is a non-Git, nonempty directory: $CORE_REPO" >&2
    exit 1
  fi
  mkdir -p "$CORE_REPO"
  git init "$CORE_REPO"
  git -C "$CORE_REPO" remote add origin "$CORE_REMOTE"
  git -C "$CORE_REPO" fetch --depth 1 origin "$PARACHUTE_CORE_REF"
  git -C "$CORE_REPO" checkout --detach FETCH_HEAD
fi

actual_ref="$(git -C "$CORE_REPO" rev-parse HEAD)"
if [ "$actual_ref" != "$PARACHUTE_CORE_REF" ]; then
  cat >&2 <<EOF
error: parachute-core checkout is not the pinned engine source.
  expected: $PARACHUTE_CORE_REF
  actual:   $actual_ref
  path:     $CORE_REPO
Use PARACHUTE_CORE_REPO to point at a clean checkout of the pinned commit.
EOF
  exit 1
fi

if [ -n "$(git -C "$CORE_REPO" status --porcelain -- "$CORE_ENGINE_DIR")" ]; then
  echo "error: pinned parachute-core engine package has local modifications: $PACKAGE_DIR" >&2
  git -C "$CORE_REPO" status --short -- "$CORE_ENGINE_DIR" >&2
  exit 1
fi

if [ ! -f "$PACKAGE_DIR/package.json" ]; then
  echo "error: pinned parachute-core checkout has no engine package: $PACKAGE_DIR" >&2
  exit 1
fi

json_field() {
  bun -e 'const p = await Bun.file(process.argv[1]).json(); process.stdout.write(String(p[process.argv[2]] ?? ""));' "$1" "$2"
}

# The engine and the workspace root are BOTH named @openparachute/core; make sure
# the file: dep resolves to the engine library, not the CLI program.
actual_name="$(json_field "$PACKAGE_DIR/package.json" name)"
if [ "$actual_name" != "@openparachute/core" ]; then
  echo "error: engine package name mismatch at $PACKAGE_DIR: expected @openparachute/core, got $actual_name" >&2
  exit 1
fi
actual_version="$(json_field "$PACKAGE_DIR/package.json" version)"
if [ "$actual_version" != "$CORE_ENGINE_VERSION" ]; then
  echo "error: engine version mismatch at $PACKAGE_DIR: expected $CORE_ENGINE_VERSION, got $actual_version" >&2
  exit 1
fi
root_version="$(json_field "$CORE_REPO/package.json" version)"
if [ "$root_version" != "$PARACHUTE_CORE_VERSION" ]; then
  echo "error: parachute-core version mismatch at $CORE_REPO: expected $PARACHUTE_CORE_VERSION, got $root_version" >&2
  exit 1
fi

echo "parachute-core v$root_version @ $actual_ref (engine v$actual_version, $PACKAGE_DIR)"
