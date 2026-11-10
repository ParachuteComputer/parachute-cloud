#!/usr/bin/env bash
# deploy/personal/deploy.sh PROFILE [EVIDENCE_DIR]: deploy the personal door (door/0.9) to the profile's own Cloudflare
# account, inside ONE sealed job (README.md; the card's templates: d1-write, r2-admin, workers-scripts-write). Each
# wrangler call gets its own short-lived child key through ./wr. Idempotent: run it again to upgrade in place.
#   1 refusals: the job's account is the profile's, never a Parachute account; the engine pin is 0.9; clean checkout
#   2 the workers.dev subdomain (asked of the account unless the profile names it)
#   3 R2 bucket <PREFIX>-vault (attachments and the nightly snapshots), created if missing
#   4 D1 <PREFIX>-identity, created if missing; render the two wrangler configs
#   5 vault worker; identity's D1 migrations; identity worker; its OPS_RUN_TOKEN (a random one, kept in PRIVATE)
#   6 both /health answer 200
# PRIVATE (default: <profile dir>/private, 0700) holds what must not be printed: the OPS token, and for a rehearsal
# profile (OWNER_PUBKEY=rehearsal) made-up owner and admin keys. Nothing secret is printed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
PROFILE="$(cd "$(dirname "${1:?profile}")" && pwd)/$(basename "$1")"
EVID="$(mkdir -p "${2:-$(dirname "$PROFILE")/evidence}" && cd "${2:-$(dirname "$PROFILE")/evidence}" && pwd)"
PRIVATE="${PRIVATE_DIR:-$(dirname "$PROFILE")/private}"
export PATH="$HOME/.bun/bin:$PATH" WR_LOG="$EVID/keys.log"
WR="$HERE/wr"
step() { echo "== $(date -u +%H:%M:%S) $*"; }
die() { echo "refused: $*" >&2; exit 2; }
fail() { echo "failed: $*" >&2; exit 1; }
# shellcheck disable=SC1090
. "$PROFILE"
: "${ACCOUNT_ID:?profile: ACCOUNT_ID}" "${PREFIX:?profile: PREFIX}" "${OWNER_PUBKEY:?profile: OWNER_PUBKEY}"

# --- 1 refusals ---
[ "${UNI_SEALED_ACCOUNT_ID:-}" = "$ACCOUNT_ID" ] || die "the job's account is not the profile's ACCOUNT_ID"
case "$ACCOUNT_ID" in
  d5d7c8646c3b69ce9f16bfd12ecbe98a|5b543fa4332a619203356ae1418af504) die "a Parachute Cloud account: the personal door never deploys there" ;;
esac
CORE_VERSION="$(. "$ROOT/scripts/core-source.env"; echo "$PARACHUTE_CORE_VERSION")"
case "$CORE_VERSION" in 0.9.*) ;; *) die "this checkout pins core $CORE_VERSION, not 0.9 (door/0.9 only)" ;; esac
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || die "the checkout has local changes"
[ -z "${WANT_SHA:-}" ] || [ "$(git -C "$ROOT" rev-parse HEAD)" = "$WANT_SHA" ] || die "the checkout is not $WANT_SHA"
(cd "$ROOT" && bash scripts/materialize-vault-core.sh >/dev/null && bash scripts/materialize-door-contract.sh >/dev/null) || die "the core or hub checkout is not the pin"
(cd "$ROOT" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install"
mkdir -p "$PRIVATE" && chmod 700 "$PRIVATE"

# Rehearsal keys: made up here, kept in PRIVATE, reused on a re-run.
if [ "$OWNER_PUBKEY" = rehearsal ]; then
  [ -s "$PRIVATE/owner.key" ] || bun "$HERE/nip98.ts" keygen "$PRIVATE/owner.key" >/dev/null
  [ -s "$PRIVATE/admin.key" ] || bun "$HERE/nip98.ts" keygen "$PRIVATE/admin.key" >/dev/null
  OWNER_PUBKEY="$(bun "$HERE/nip98.ts" pubkey "$PRIVATE/owner.key")"
  ADMIN_PUBKEYS="$(bun "$HERE/nip98.ts" pubkey "$PRIVATE/admin.key")"
fi
[ -s "$PRIVATE/ops-run-token" ] || (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$PRIVATE/ops-run-token")
RENDER_PROFILE="$(mktemp)"; trap 'rm -f "$RENDER_PROFILE"' EXIT
{ cat "$PROFILE"; printf 'OWNER_PUBKEY=%q\nADMIN_PUBKEYS=%q\n' "$OWNER_PUBKEY" "${ADMIN_PUBKEYS:-}"; } > "$RENDER_PROFILE"

# --- 2 workers.dev subdomain ---
SUB="${WORKERS_SUBDOMAIN:-}"
if [ -z "$SUB" ]; then
  SUB="$("$WR" --api workers/subdomain 2>/dev/null | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).result?.subdomain??"")}catch{}})')"
fi
[ -n "$SUB" ] || fail "the account has no workers.dev subdomain (or it couldn't be read); set WORKERS_SUBDOMAIN"
step "account ok; workers.dev subdomain $SUB; core $CORE_VERSION; cloud $(git -C "$ROOT" rev-parse --short HEAD)"

# --- 3 R2 bucket ---
out="$("$WR" r2 bucket create "$PREFIX-vault" 2>&1)" || grep -qi "already exists" <<<"$out" || { grep -vi token <<<"$out" | tail -5; fail "r2 bucket create"; }
step "R2 bucket $PREFIX-vault ready"

# --- 4 D1 + render ---
cd "$ROOT/workers/identity"
db_id() { "$WR" d1 list --json 2>/dev/null | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(x?x.uuid:"")}catch{}})' "$PREFIX-identity"; }
ID="$(db_id)"
if [ -z "$ID" ]; then "$WR" d1 create "$PREFIX-identity" >/dev/null 2>&1 || true; ID="$(db_id)"; fi
[ -n "$ID" ] || fail "no D1 id for $PREFIX-identity"
bash "$HERE/render.sh" "$RENDER_PROFILE" "$ID" "$SUB" || fail "render"
step "D1 $PREFIX-identity ($ID)"

# --- 5 deploy ---
run() { local o; o="$("$WR" "$@" 2>&1)"; local rc=$?; grep -vi token <<<"$o" | grep -E "workers.dev|Current Version ID|Uploaded|applied|No migrations|Success|✅|ERROR|✘" | cut -c1-160; return $rc; }
cd "$ROOT/workers/vault"
run deploy -c wrangler.personal.gen.toml --x-provision=false || fail "vault deploy"
cd "$ROOT/workers/identity"
run d1 migrations apply "$PREFIX-identity" --remote -c wrangler.personal.gen.toml || fail "identity D1 migrations"
run deploy -c wrangler.personal.gen.toml --x-provision=false || fail "identity deploy"
"$WR" secret put OPS_RUN_TOKEN -c wrangler.personal.gen.toml < "$PRIVATE/ops-run-token" >/dev/null 2>&1 || fail "OPS_RUN_TOKEN"
step "deployed"

# --- 6 health ---
ID_ORIGIN="https://${IDENTITY_DOMAIN:-$PREFIX-identity.$SUB.workers.dev}"
V_ORIGIN="https://${VAULT_DOMAIN:-$PREFIX-vault.$SUB.workers.dev}"
for i in $(seq 1 30); do
  a="$(curl -s -o /dev/null -w '%{http_code}' "$ID_ORIGIN/health")"; b="$(curl -s -o /dev/null -w '%{http_code}' "$V_ORIGIN/health")"
  [ "$a" = 200 ] && [ "$b" = 200 ] && break; sleep 4
done
printf 'IDENTITY=%s\nVAULT=%s\nPREFIX=%s\nD1_ID=%s\nCLOUD_SHA=%s\n' "$ID_ORIGIN" "$V_ORIGIN" "$PREFIX" "$ID" "$(git -C "$ROOT" rev-parse HEAD)" > "$EVID/deployed.env"
[ "$a" = 200 ] && [ "$b" = 200 ] || fail "health: identity $a, vault $b"
step "health: identity 200, vault 200 ($ID_ORIGIN, $V_ORIGIN)"
