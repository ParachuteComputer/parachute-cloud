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
# One public name (optional, T-335): PUBLIC_DOMAIN, a host on a zone of the same account. The identity worker takes it
# as a Custom Domain; since #428 that worker hands /vault/*, /mcp and their discovery documents to the vault worker over
# VAULT_SERVICE, so the whole door answers on the name with no zone route. The issuer stays the workers.dev identity
# (sign-in and consent happen there, as Cloud's happen at cloud. while people connect at my.), so every token, key and
# connection made before keeps working at both names. The name is added to the bound origins and becomes the address
# the door gives out (VAULT_PUBLIC_ORIGIN). test-bun/personal-public-domain.test.ts pins this.
[ -z "${VAULT_DOMAIN:-}${IDENTITY_DOMAIN:-}${PUBLIC_ZONE:-}" ] || { echo "refused: VAULT_DOMAIN, IDENTITY_DOMAIN and PUBLIC_ZONE are replaced by PUBLIC_DOMAIN (one name, on the identity worker)" >&2; exit 2; }
PD="${PUBLIC_DOMAIN:-}"
if [ -n "$PD" ]; then
  [[ "$PD" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "refused: PUBLIC_DOMAIN must be a plain host name" >&2; exit 2; }
  case "$PD" in *.workers.dev|parachute.computer|*.parachute.computer) echo "refused: PUBLIC_DOMAIN must be the owner's own name" >&2; exit 2 ;; esac
fi
PLAN="${OWNER_PLAN:-power}"; case "$PLAN" in entry|standard|plus|power) ;; *) echo "refused: OWNER_PLAN" >&2; exit 2 ;; esac
VAULT_HOST="$PREFIX-vault.$SUB.workers.dev"
ID_ORIGIN="https://$PREFIX-identity.$SUB.workers.dev"
# workers.dev always; with PUBLIC_DOMAIN, the identity's Custom Domain too. The vault worker never takes a route.
ID_ROUTES='routes = []'; PUBLIC_ORIGIN="$ID_ORIGIN"; BOUND='# no PUBLIC_DOMAIN: the issuer is the only bound origin'
if [ -n "$PD" ]; then
  ID_ROUTES="routes = [{ pattern = \"$PD\", custom_domain = true }]"; PUBLIC_ORIGIN="https://$PD"; BOUND="BOUND_ORIGINS = \"$PUBLIC_ORIGIN\""
fi
sub() {
  sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@D1_ID@|$D1_ID|g" -e "s|@VAULT_HOST@|$VAULT_HOST|g" \
      -e "s|@VAULT_ORIGIN@|https://$VAULT_HOST|g" -e "s|@IDENTITY_ORIGIN@|$ID_ORIGIN|g" -e "s|@PUBLIC_ORIGIN@|$PUBLIC_ORIGIN|g" \
      -e "s|@OWNER_PUBKEY@|$OWNER_PUBKEY|g" -e "s|@ADMIN_PUBKEYS@|${ADMIN_PUBKEYS:-}|g" -e "s|@OWNER_PLAN@|$PLAN|g" \
      -e "s|@VAULT_ROUTES@|routes = []|" -e "s|@IDENTITY_ROUTES@|$ID_ROUTES|" -e "s|@BOUND_ORIGINS@|$BOUND|" "$1"
}
sub "$HERE/vault.toml.tmpl" > "$ROOT/workers/vault/wrangler.personal.gen.toml"
sub "$HERE/identity.toml.tmpl" > "$ROOT/workers/identity/wrangler.personal.gen.toml"
echo "rendered: vault $PREFIX-vault (https://$VAULT_HOST), identity $PREFIX-identity ($ID_ORIGIN)${PD:+; public name $PUBLIC_ORIGIN on the identity}"
