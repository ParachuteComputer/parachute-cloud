#!/usr/bin/env bash
# deploy/personal/vault-limit.sh PROFILE N|plan: set the owner's own vault limit (0..1000), or `plan` to clear it and go
# back to OWNER_PLAN's count. The same lever an operator pulls on Parachute Cloud (users.vault_limit_override, T-505):
# on your own door you are the operator, so it is one D1 update. Existing vaults are never touched; only a new vault
# past the limit is refused. Run it with your wrangler sign-in or inside a sealed job with d1-write (./wr), from the
# checkout you deployed from (it
# reads that deploy's workers/identity/wrangler.personal.gen.toml), after the owner has signed in once (the sign-in
# makes the account).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
PROFILE="${1:?profile}"; WANT="${2:?a number 0..1000, or plan}"
# shellcheck disable=SC1090
. "$PROFILE"
: "${PREFIX:?profile: PREFIX}" "${OWNER_PUBKEY:?profile: OWNER_PUBKEY}"
# The same refusals as deploy.sh and render.sh: the profile's own account only, never Parachute Cloud's, never a prefix
# that could name a Parachute Cloud or Arcade database.
ACCOUNT_ID="$(tr 'A-F' 'a-f' <<<"${ACCOUNT_ID:?profile: ACCOUNT_ID}")"
case "$ACCOUNT_ID" in
  d5d7c8646c3b69ce9f16bfd12ecbe98a|5b543fa4332a619203356ae1418af504) echo "refused: a Parachute Cloud account" >&2; exit 2 ;;
esac
[[ "$PREFIX" =~ ^[a-z][a-z0-9-]{2,40}[a-z0-9]$ ]] || { echo "refused: PREFIX must be lowercase letters, digits and -" >&2; exit 2; }
case "$PREFIX" in parachute|parachute-*|arcade-parachute*|*-staging) echo "refused: PREFIX $PREFIX could name a Parachute Cloud or Arcade database" >&2; exit 2 ;; esac
if [ -n "${UNI_SEALED_ACCOUNT_ID:-}" ]; then
  [ "$(tr 'A-F' 'a-f' <<<"$UNI_SEALED_ACCOUNT_ID")" = "$ACCOUNT_ID" ] || { echo "refused: the job's account is not the profile's ACCOUNT_ID" >&2; exit 2; }
else
  export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
fi
case "$WANT" in plan) VAL=NULL ;; *) [[ "$WANT" =~ ^[0-9]{1,4}$ ]] && [ "$WANT" -le 1000 ] || { echo "refused: a limit is 0..1000, or plan" >&2; exit 2; }; VAL="$WANT" ;; esac
PRIVATE="${PRIVATE_DIR:-$(dirname "$PROFILE")/private}"
if [ "$OWNER_PUBKEY" = rehearsal ]; then OWNER="$(bun "$HERE/nip98.ts" pubkey "$PRIVATE/owner.key")"; else OWNER="$(bun "$HERE/nip98.ts" hex "$OWNER_PUBKEY")"; fi
[[ "$OWNER" =~ ^[0-9a-f]{64}$ ]] || { echo "refused: OWNER_PUBKEY isn't a key" >&2; exit 2; }
CFG="$ROOT/workers/identity/wrangler.personal.gen.toml"
[ -s "$CFG" ] || { echo "refused: no $CFG (run from the checkout you deployed from)" >&2; exit 2; }
cd "$ROOT/workers/identity"
# The owner's account: the one OWNER_PUBKEY's first sign-in made (its placeholder address), or the one it is linked to.
SQL="UPDATE users SET vault_limit_override = $VAL WHERE deleted_at IS NULL AND (email = '$OWNER@nostr.invalid' OR id IN (SELECT user_id FROM user_pubkeys WHERE pubkey = '$OWNER'))"
out="$("$HERE/wr" d1 execute "$PREFIX-identity" --remote --json -c "$CFG" --command "$SQL")"
n="$(grep -o '"changes": *[0-9]*' <<<"$out" | head -1 | grep -o '[0-9]*$' || true)"
[ "${n:-0}" -ge 1 ] || { echo "failed: no owner row updated (not signed in yet, or wrangler answered something unexpected: see above)" >&2; exit 1; }
echo "vault limit: $WANT (owner ${OWNER:0:8}…)"
