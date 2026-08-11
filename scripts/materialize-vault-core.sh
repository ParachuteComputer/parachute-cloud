#!/usr/bin/env bash
# Materialize the exact parachute-vault core source used by Cloud CI and deploys.
# Existing developer checkouts are verified but never switched or reset.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="${VAULT_CORE_SOURCE_FILE:-$ROOT/scripts/vault-source.env}"
# shellcheck source=vault-source.env
source "$SOURCE_FILE"

VAULT_REPO="${PARACHUTE_VAULT_REPO:-$ROOT/../parachute-vault}"
VAULT_REMOTE="${PARACHUTE_VAULT_REMOTE:-https://github.com/ParachuteComputer/parachute-vault.git}"
PACKAGE_DIR="$VAULT_REPO/core"

if ! git -C "$VAULT_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -e "$VAULT_REPO" ] && [ ! -d "$VAULT_REPO" ]; then
    echo "error: PARACHUTE_VAULT_REPO is not a directory: $VAULT_REPO" >&2
    exit 1
  fi
  if [ -d "$VAULT_REPO" ] && [ -n "$(find "$VAULT_REPO" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "error: PARACHUTE_VAULT_REPO is a non-Git, nonempty directory: $VAULT_REPO" >&2
    exit 1
  fi
  mkdir -p "$VAULT_REPO"
  git init "$VAULT_REPO"
  git -C "$VAULT_REPO" remote add origin "$VAULT_REMOTE"
  git -C "$VAULT_REPO" fetch --depth 1 origin "$VAULT_CORE_REF"
  git -C "$VAULT_REPO" checkout --detach FETCH_HEAD
fi

actual_ref="$(git -C "$VAULT_REPO" rev-parse HEAD)"
if [ "$actual_ref" != "$VAULT_CORE_REF" ]; then
  cat >&2 <<EOF
error: parachute-vault checkout is not the pinned vault-core source.
  expected: $VAULT_CORE_REF
  actual:   $actual_ref
  path:     $VAULT_REPO
Use PARACHUTE_VAULT_REPO to point at a clean checkout of the pinned commit.
EOF
  exit 1
fi

if [ -n "$(git -C "$VAULT_REPO" status --porcelain -- core)" ]; then
  echo "error: pinned parachute-vault core subtree has local modifications: $VAULT_REPO" >&2
  git -C "$VAULT_REPO" status --short -- core >&2
  exit 1
fi

if [ ! -f "$PACKAGE_DIR/package.json" ]; then
  echo "error: pinned parachute-vault checkout has no core package: $PACKAGE_DIR" >&2
  exit 1
fi
actual_version="$(bun -e 'const p = await Bun.file(process.argv[1]).json(); process.stdout.write(String(p.version ?? ""));' "$PACKAGE_DIR/package.json")"
if [ "$actual_version" != "$VAULT_CORE_VERSION" ]; then
  echo "error: vault-core version mismatch at $PACKAGE_DIR: expected $VAULT_CORE_VERSION, got $actual_version" >&2
  exit 1
fi

echo "vault-core v$actual_version @ $actual_ref ($PACKAGE_DIR)"
