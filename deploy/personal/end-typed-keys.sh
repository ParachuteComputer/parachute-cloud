#!/usr/bin/env bash
# deploy/personal/end-typed-keys.sh <identity origin> <key file>
# Run BEFORE rolling this door back to any commit before the T-476 stack (#437, 730b476): door/0.9 at 0d0bf9e,
# 612f2b0, 4f7bedf and older. Those vault workers don't know a typed key's grant (`permissions.grant`) and would serve
# it as a whole-vault key at its level. (Rolling back to #437 or #438 is safe: those refuse the key outright.)
# Run it while this door's own identity worker is still live (an older one doesn't list `types`), and make no typed
# key between this run and the rollback.
# Signs in with <key file> (the owner's key, or an ADMIN_PUBKEYS key), lists /account/keys, and revokes each live key
# that has `types`. Prints key names and statuses only; the account token stays in a temp file.
# Fails closed: exit 0 only when the list was read (HTTP 200, a `keys` list) and no typed key is left live; any
# other answer, a failed revoke, or a failed sign-in is exit 1 (then don't roll back).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
I="${1:?identity origin, e.g. https://<prefix>-identity.<subdomain>.workers.dev}"; KEY="${2:?key file}"
I="${I%/}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL end-typed-keys: $*"; exit 1; }
bun "$HERE/nip98.ts" token "$I" "$KEY" "$T/acct.curl" > /dev/null 2> "$T/signin.err" || fail "sign-in at $I: $(tail -1 "$T/signin.err")"
# The live typed keys' names, one per line; exits non-zero unless the list answered 200 with a `keys` list.
live() {
  local code
  code=$(curl -sS -o "$T/keys.json" -w '%{http_code}' -K "$T/acct.curl" "$I/account/keys") || return 1
  [ "$code" = 200 ] || { echo "the key list answered $code" >&2; return 1; }
  python3 -I -c 'import json,sys
b = json.load(open(sys.argv[1]))
keys = b.get("keys") if isinstance(b, dict) else None
if not isinstance(keys, list): sys.exit("the key list has no keys")
for k in keys:
    if k.get("types") and k.get("status") == "active": print(k["name"])' "$T/keys.json"
}
names=$(live) || fail "couldn't read the key list"
if [ -z "$names" ]; then echo "PASS end-typed-keys (none live)"; exit 0; fi
for n in $names; do
  enc=$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$n")
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -K "$T/acct.curl" "$I/account/keys/$enc") || code=000
  [ "$code" = 200 ] || fail "revoking $n answered $code"
  echo "ended typed key $n"
done
left=$(live) || fail "couldn't read the key list after revoking"
[ -z "$left" ] || fail "still live: $left"
echo "PASS end-typed-keys ($(echo "$names" | wc -w) ended)"
