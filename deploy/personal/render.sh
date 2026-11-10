#!/usr/bin/env bash
# deploy/personal/render.sh PROFILE D1_ID SUBDOMAIN: write workers/{vault,identity}/wrangler.personal.gen.toml from the
# templates and a profile (README.md). Pure text, no network, no key. Refuses a prefix that could name a Parachute Cloud
# or Arcade worker, and a key that is neither 64 hex nor npub.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
PROFILE="${1:?profile}"; D1_ID="${2:?d1 id}"; SUB="${3:?workers.dev subdomain}"
# shellcheck disable=SC1090
. "$PROFILE"
: "${PREFIX:?}" "${OWNER_PUBKEY:?}"
[[ "$PREFIX" =~ ^[a-z][a-z0-9-]{2,40}[a-z0-9]$ ]] || { echo "refused: PREFIX must be lowercase letters, digits and -" >&2; exit 2; }
case "$PREFIX" in parachute|parachute-*|arcade-parachute*|*-staging) echo "refused: PREFIX $PREFIX could name a Parachute Cloud or Arcade worker" >&2; exit 2 ;; esac
[[ "$SUB" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "refused: bad workers.dev subdomain" >&2; exit 2; }
[[ "$D1_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "refused: bad D1 id" >&2; exit 2; }
key_ok() { [[ "$1" =~ ^[0-9a-f]{64}$ || "$1" =~ ^npub1[02-9ac-hj-np-z]{58}$ ]]; }
key_ok "$OWNER_PUBKEY" || { echo "refused: OWNER_PUBKEY is not 64 hex or an npub" >&2; exit 2; }
for k in ${ADMIN_PUBKEYS//,/ }; do key_ok "$k" || { echo "refused: an ADMIN_PUBKEYS entry is not 64 hex or an npub" >&2; exit 2; }; done
for d in "${VAULT_DOMAIN:-}" "${IDENTITY_DOMAIN:-}"; do
  [ -z "$d" ] || [[ "$d" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "refused: a custom domain must be a plain host name" >&2; exit 2; }
done
PLAN="${OWNER_PLAN:-power}"; case "$PLAN" in entry|standard|plus|power) ;; *) echo "refused: OWNER_PLAN" >&2; exit 2 ;; esac
VAULT_HOST="${VAULT_DOMAIN:-$PREFIX-vault.$SUB.workers.dev}"
ID_ORIGIN="https://${IDENTITY_DOMAIN:-$PREFIX-identity.$SUB.workers.dev}"
# A custom domain (optional): one Custom Domain route per worker; otherwise workers.dev only.
route() { [ -n "$1" ] && printf 'routes = [{ pattern = "%s", custom_domain = true }]' "$1" || printf 'routes = []'; }
sub() {
  sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@D1_ID@|$D1_ID|g" -e "s|@VAULT_HOST@|$VAULT_HOST|g" \
      -e "s|@VAULT_ORIGIN@|https://$VAULT_HOST|g" -e "s|@IDENTITY_ORIGIN@|$ID_ORIGIN|g" \
      -e "s|@OWNER_PUBKEY@|$OWNER_PUBKEY|g" -e "s|@ADMIN_PUBKEYS@|${ADMIN_PUBKEYS:-}|g" -e "s|@OWNER_PLAN@|$PLAN|g" \
      -e "s|@VAULT_ROUTES@|$(route "${VAULT_DOMAIN:-}")|" -e "s|@IDENTITY_ROUTES@|$(route "${IDENTITY_DOMAIN:-}")|" "$1"
}
sub "$HERE/vault.toml.tmpl" > "$ROOT/workers/vault/wrangler.personal.gen.toml"
sub "$HERE/identity.toml.tmpl" > "$ROOT/workers/identity/wrangler.personal.gen.toml"
echo "rendered: vault $PREFIX-vault (https://$VAULT_HOST), identity $PREFIX-identity ($ID_ORIGIN)"
