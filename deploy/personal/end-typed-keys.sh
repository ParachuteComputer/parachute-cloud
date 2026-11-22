#!/usr/bin/env bash
# deploy/personal/end-typed-keys.sh <identity origin> <key file>
# Before rolling this door back to a commit from before typed keys (612f2b0 or older): end every live key held to some
# types. Those vault workers don't know a typed key's grant (`permissions.grant`) and would serve it as a whole-vault
# key at its level. Signs in with <key file> (the owner's key, or an ADMIN_PUBKEYS key), lists /account/keys, and
# revokes each live key that has `types`. Prints key names and statuses only; the account token stays in a temp file.
# Exit 0 when no typed key is left live; 1 otherwise (then don't roll back).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
I="${1:?identity origin, e.g. https://<prefix>-identity.<subdomain>.workers.dev}"; KEY="${2:?key file}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
bun "$HERE/nip98.ts" token "$I" "$KEY" "$T/acct.curl" >/dev/null 2>&1 || { echo "FAIL sign-in at $I"; exit 1; }
live() {
  curl -s -K "$T/acct.curl" "$I/account/keys" | python3 -I -c 'import json,sys
for k in json.load(sys.stdin).get("keys", []):
    if k.get("types") and k.get("status") == "active": print(k["name"])'
}
names=$(live)
if [ -z "$names" ]; then echo "PASS end-typed-keys (none live)"; exit 0; fi
for n in $names; do
  enc=$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$n")
  echo "revoked typed key $n: $(curl -s -o /dev/null -w '%{http_code}' -X DELETE -K "$T/acct.curl" "$I/account/keys/$enc")"
done
left=$(live)
if [ -z "$left" ]; then echo "PASS end-typed-keys ($(echo "$names" | wc -w) ended)"; exit 0; fi
echo "FAIL end-typed-keys (still live: $left)"; exit 1
