#!/usr/bin/env bash
# scripts/release/prod-job.sh: THE production deploy, as a sealed-card job (T-413). Production deploys from `next` this
# way until Aaron decides about `main` (deploy-prod.yml deploys the default branch, which is far behind; don't use it).
# It ships the commit staging proved to both production workers through scripts/deploy-prod.sh unchanged (its health
# gate, D1 migrations, identity then vault, the edge-propagation wait), then read-only checks and smoke-prod.ts. Any
# failure after a worker changed rolls BOTH back to the versions production ran before (EXPECT_LIVE_*; it refuses to
# start if production is on anything else). Run inside a sealed job card (payload: d1-write + workers-scripts-write,
# 600 s), after the staging card's SUMMARY.txt is all PASS:
#   OPERATOR_EMAIL_FILE=<file> python sealed/cli.py job --payload <payload.json> -- \
#     bash scripts/release/prod-job.sh <this checkout> <sha> <evidence dir> <staging evidence dir>
# The staging evidence is a SUMMARY.txt with a PASS line per suite (deploy-staging, health-proof, health-report-d1,
# t412-rows, smoke-staging, opimport, one-deploy) and "cloud <sha> on staging: ..." (T-413's staging job writes it).
# Every Cloudflare call gets its own child key through scripts/release/bunx (d1-write for D1, workers-scripts-write
# for the rest); `wrangler deploy` goes out as versions upload + deploy (the workers key may not re-PUT custom domains;
# check-triggers.sh refuses a release that changes routes, crons or DO migrations). A rollback is both workers under
# one key, kept the last 180 s of the window. Exit (also in <evidence dir>/exit-code.txt): 0 shipped and checked; 1
# failed and rolled back (proven); 2 refused, nothing changed; 3 the health gate said something got worse, nothing
# deployed; 4 a rollback that could not be proven: the "!!" lines give the commands to run by hand. Nothing secret
# printed. Rehearsed by T-413's harness (fake wrangler, curl, sealed CLI; the real deploy-prod.sh).
set -uo pipefail
CLOUD="$(cd "${1:?usage: prod-job.sh <cloud checkout> <sha> <evidence dir> <staging evidence dir>}" && pwd)"
WANT="${2:?sha}"; EVID="$(mkdir -p "${3:?evidence dir}" && cd "$3" && pwd)"; STG="$(cd "${4:?staging evidence dir}" && pwd)"
R="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # scripts/release: this script, the key shim, the checks
CF_ACCOUNT=d5d7c8646c3b69ce9f16bfd12ecbe98a; PROD_LIVE=423362e
# What production runs now: cloud next 423362e, deployed 11-03 19:09 UTC (t318-review2-fixes evidence/prod-423362e).
OLD_VAULT="${EXPECT_LIVE_VAULT:-1bc2cef3-c851-47a3-8845-051f9b48950f}"
OLD_ID="${EXPECT_LIVE_IDENTITY:-faffb93d-b6bc-4830-a483-fff22aec6876}"
ISSUER=https://cloud.parachute.computer; MY=https://my.parachute.computer; VH=https://u.parachute.computer
WINDOW_S="${WINDOW_S:-600}"
# The broker refuses a mint with under 60 s left and revokes every key 30 s before the window ends; a mint can take
# up to 30 s to go live. KEY_MARGIN_S keeps the last 180 s for the rollback alone (one key, both workers: ~60 s).
KEY_MARGIN_S=180
export PY="${PY:-$HOME/REPOS/hermes-agent/.venv/bin/python}"
export TMPDIR="${TMPDIR:-$HOME/.cache/parachute-release-tmp}"; export WRANGLER_LOG_PATH="$TMPDIR/wrangler-logs-prod"
export PATH="$R:$HOME/.bun/bin:$PATH" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT" WRANGLER_SEND_METRICS=false WRANGLER_LOG_SANITIZE=true
export SHIM_LOG="$EVID/keys.log" DEPLOYED_LOG="$EVID/deployed.txt" WANT_SHA="$WANT" DEPLOY_MESSAGE="T-413 cloud next ${WANT:0:7}"
mkdir -p "$TMPDIR"; : > "$DEPLOYED_LOG"
APP="$CLOUD/../parachute-app"; OPF="${OPERATOR_EMAIL_FILE:?OPERATOR_EMAIL_FILE: a file holding only DEV_USER_EMAIL=<the production operator address>}"; DS="$CLOUD/workers/identity/.dev-secrets"
T0=$(date +%s)
trap 'echo "$?" > "$EVID/exit-code.txt"' EXIT   # launch-card.sh runs the job detached: the code is kept here
step() { echo "== $(date -u +%H:%M:%S) +$(( $(date +%s) - T0 ))s $*" | tee -a "$EVID/log.txt"; }
refuse() { echo "refused: $*" | tee -a "$EVID/log.txt" >&2; exit 2; }
left() { echo $(( T0 + WINDOW_S - KEY_MARGIN_S - $(date +%s) )); }   # seconds left for anything but a rollback
SEALED="${SEALED:-$HOME/Code/uni-ops/sealed/cli.py}"; RBX="${REAL_BUNX:-$HOME/.bun/bin/bunx}"
edge() { curl -s --max-time 10 "$ISSUER/health" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("version") or "")' 2>/dev/null || true; }
# lives: "<vault> <identity>", the version at 100% of each, both read under ONE key (two tries each); "-" when
# unreadable or split. One mint, not two: mints are what the window's time goes on.
lives() {
  local out
  out="$(cd "$HOME/Code/uni-ops" && "$PY" -I "$SEALED" job-child workers-scripts-write -- bash -c '
    cd "$0"; export CLOUDFLARE_API_TOKEN="$(cat <&"$UNI_SEALED_FD")"
    for n in parachute-vault-do parachute-identity; do
      v=""; for i in 1 2; do v="$("$1" wrangler deployments status --name "$n" --json 2>/dev/null | python3 -I "$2")"; [ -n "$v" ] && break; sleep 3; done
      printf "%s " "${v:--}"
    done' "$CLOUD/workers" "$RBX" "$R/version-at-100.py" 2>/dev/null)"
  set -- $out; echo "${1:--} ${2:--}"
}
# --- refusals: nothing has changed yet ---
[ "${UNI_SEALED_ACCOUNT_ID:-}" = "$CF_ACCOUNT" ] || refuse "the job is not on the Parachute account"
[ "$(git -C "$CLOUD" rev-parse HEAD)" = "$WANT" ] || refuse "checkout is not $WANT"
[ -z "$(git -C "$CLOUD" status --porcelain --untracked-files=no)" ] || refuse "checkout has local changes"
CORE_WANT="$(. "$CLOUD/scripts/core-source.env"; echo "$PARACHUTE_CORE_REF")"
[ "$(git -C "$CLOUD/../parachute-core" rev-parse HEAD)" = "$CORE_WANT" ] || refuse "core checkout is not the pin"
HUB_WANT="$(. "$CLOUD/scripts/door-contract-source.env"; echo "$DOOR_CONTRACT_HUB_REF")"
[ "$(git -C "$CLOUD/../parachute-hub" rev-parse HEAD)" = "$HUB_WANT" ] || refuse "hub checkout is not the door-contract pin"
SPA_REF="$(. "$CLOUD/scripts/spa-source.env"; echo "$SPA_APP_REF")"; SPA_WANT="$(. "$CLOUD/scripts/spa-source.env"; echo "$SPA_APP_VERSION")"
[ "$(git -C "$APP" rev-parse HEAD)" = "$SPA_REF" ] || refuse "app checkout is not the SPA pin"
[ -z "$(git -C "$APP" status --porcelain | grep -v '^ M meta.json$')" ] || refuse "app checkout has changes beyond meta.json"
git -C "$APP" checkout -- meta.json   # the app build rewrites it; build-spa.sh would refuse the checkout
bash "$R/check-triggers.sh" "$CLOUD" "$PROD_LIVE" "$WANT" > "$EVID/check-triggers.txt" || refuse "routes/crons/DO migrations changed since $PROD_LIVE"
# Staging proved this code: every suite passed on a deploy of a commit whose difference from this one is only the
# smoke scripts and the package version line (nothing that reaches a worker bundle).
S="$STG/SUMMARY.txt"; [ -f "$S" ] || refuse "no staging SUMMARY.txt in $STG"
! grep -qE '^(FAIL|REFUSED)' "$S" || refuse "staging has a FAIL: $(grep -E '^(FAIL|REFUSED)' "$S" | head -1 | cut -c1-80)"
for suite in deploy-staging health-proof health-report-d1 t412-rows smoke-staging opimport one-deploy; do
  grep -q "^PASS $suite " "$S" || refuse "staging has no PASS for $suite"
done
STAGED="$(sed -n 's/^cloud \([0-9a-f]\{40\}\) on staging:.*/\1/p' "$S" | tail -1)"
[ -n "$STAGED" ] && git -C "$CLOUD" cat-file -e "$STAGED^{commit}" 2>/dev/null || refuse "staging SUMMARY.txt names no commit this checkout has"
OTHER="$(git -C "$CLOUD" diff --name-only "$STAGED" "$WANT" | grep -vE '^scripts/smoke-[a-z0-9-]+\.ts$|^package\.json$')"
[ -z "$OTHER" ] || refuse "$WANT differs from the staged ${STAGED:0:7} beyond the smoke scripts: $(echo $OTHER | cut -c1-120)"
[ -z "$(git -C "$CLOUD" diff "$STAGED" "$WANT" -- package.json | grep -E '^[+-][^+-]' | grep -vE '^[+-]\s*"version": ')" ] \
  || refuse "package.json differs from the staged ${STAGED:0:7} beyond its version line"
timeout -k 5 30 git -C "$CLOUD" fetch -q origin 2>/dev/null
[ -n "$(git -C "$CLOUD" branch -r --contains "$WANT" 2>/dev/null)" ] || refuse "$WANT is on no origin branch: production runs a commit the repo has"
# smoke-prod.ts reads the operator address from .dev-secrets: production's, never the made-up staging user.
[ -f "$OPF" ] && grep -q '^DEV_USER_EMAIL=.' "$OPF" && ! grep -q '^DEV_USER_PASSWORD' "$OPF" || refuse "no email-only $OPF"
! grep -q '@example\.com$' <(grep '^DEV_USER_EMAIL=' "$OPF") || refuse "$OPF holds a made-up address"
# The operator-import doors answer 404 without OPS_RUN_TOKEN, and the checks below would roll back on that.
[ "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$ISSUER/ops/snapshot-run")" = 401 ] || refuse "OPS_RUN_TOKEN is not set on production"
BK="$TMPDIR/dev-secrets.before.$$"
if [ -f "$DS" ]; then cp -p "$DS" "$BK" || refuse "could not keep a copy of $DS"; fi
trap 'rc=$?; if [ -f "$BK" ]; then mv -f "$BK" "$DS"; else rm -f "$DS"; fi; echo "$rc" > "$EVID/exit-code.txt"' EXIT
(umask 077; cp "$OPF" "$DS") && cmp -s "$OPF" "$DS" || refuse "could not put the operator address in place for smoke-prod"

step "cloud $(git -C "$CLOUD" log --oneline -1 | cut -c1-70) (staged ${STAGED:0:7}); core ${CORE_WANT:0:7}; app $SPA_WANT"
# Production must be exactly where we think it is, or the rollback targets are wrong.
read -r LV LI <<<"$(lives)"; E0="$(edge)"
echo "before: parachute-vault-do ${LV:-?}, parachute-identity ${LI:-?}, edge ${E0:-?}" | tee "$EVID/versions-before.txt"
[ "$LV" = "$OLD_VAULT" ] && [ "$LI" = "$OLD_ID" ] && [ "$E0" = "$OLD_ID" ] \
  || refuse "production is not on ${PROD_LIVE}'s versions (vault $OLD_VAULT, identity $OLD_ID): look first; set EXPECT_LIVE_VAULT/EXPECT_LIVE_IDENTITY only after checking"

# rollback <why>: both workers back to 423362e's versions under ONE key (vault first: the deploy's order, reversed),
# no reads before it (rolling back a worker that never moved is a harmless new deployment of the same version), then
# proof: the edge serves the old identity and the vault reads back old. Exit 1 when proven, 4 when not.
rollback() {
  local why="$1" out
  step "!! $why -> rolling back both workers to ${PROD_LIVE}'s versions"; echo "why: $why" >> "$EVID/rollback.txt"
  out="$(cd "$HOME/Code/uni-ops" && "$PY" -I "$SEALED" job-child workers-scripts-write -- bash -c '
    cd "$0"; export CLOUDFLARE_API_TOKEN="$(cat <&"$UNI_SEALED_FD")"; rb="$1"; shift
    for pair in "$@"; do
      set -- $pair; done_=0
      for i in 1 2 3; do
        if (cd "$3" && "$rb" wrangler rollback "$2" --name "$1" -m "T-413: a check failed; back to 423362e" -y) > /dev/null 2>&1; then
          echo "$1 rolled back to $2"; done_=1; break; fi
        sleep 5
      done
      [ $done_ = 1 ] || echo "!! ROLLBACK FAILED for $1: by hand: wrangler rollback $2 --name $1"
    done' "$CLOUD/workers" "$RBX" "parachute-vault-do $OLD_VAULT vault" "parachute-identity $OLD_ID identity" 2>&1)"
  echo "$out" | grep -E "rolled back|ROLLBACK FAILED|refused|minted" | tee -a "$EVID/rollback.txt"
  grep -q "parachute-vault-do rolled back" <<<"$out" || echo "!! ROLLBACK FAILED for parachute-vault-do (no key, or wrangler refused): by hand: wrangler rollback $OLD_VAULT --name parachute-vault-do" | tee -a "$EVID/rollback.txt"
  grep -q "parachute-identity rolled back" <<<"$out" || echo "!! ROLLBACK FAILED for parachute-identity (no key, or wrangler refused): by hand: wrangler rollback $OLD_ID --name parachute-identity" | tee -a "$EVID/rollback.txt"
  local e="" v
  for i in $(seq 1 30); do e="$(edge)"; [ "$e" = "$OLD_ID" ] && break; sleep 3; done
  read -r v i <<<"$(lives)"
  echo "after rollback: edge ${e:-?}, vault $v, identity $i (- = unreadable)" | tee -a "$EVID/rollback.txt"
  # Proven only if both commands succeeded AND what we can read says old: the edge alone can still show the old
  # identity when the new one never propagated, while the worker itself is on the new version.
  if grep -q "parachute-vault-do rolled back" <<<"$out" && grep -q "parachute-identity rolled back" <<<"$out" \
     && [ "$e" = "$OLD_ID" ] && { [ "$v" = "$OLD_VAULT" ] || [ "$v" = - ]; } && { [ "$i" = "$OLD_ID" ] || [ "$i" = - ]; }; then
    step "rolled back: production is on ${PROD_LIVE}'s versions again"; exit 1
  fi
  step "!! PRODUCTION NOT ROLLED BACK (edge ${e:-?}, vault ${v:-?}, identity ${i:-?}): check and roll back by hand:"
  step "!!   wrangler rollback $OLD_VAULT --name parachute-vault-do ; wrangler rollback $OLD_ID --name parachute-identity"; exit 4
}
# wait_edge <version> <max s>: poll the identity edge until it serves <version>, never past the key budget.
wait_edge() { local end=$(( $(date +%s) + $2 )); while :; do [ "$(edge)" = "$1" ] && return 0; [ "$(date +%s)" -lt "$end" ] && [ "$(left)" -gt 0 ] || return 1; sleep 3; done; }

# --- the health gate, read on its own first: an unreadable report must stop us, not wave the deploy through ---
unset HEALTH_GATE
step "1. health gate (read-only D1 SELECTs; verdict and counts only)"
(cd "$CLOUD" && timeout -k 10 150 bun scripts/health-report.ts --d1 parachute-identity --gate --public) > "$EVID/health-gate.txt" 2>&1; G=$?
cat "$EVID/health-gate.txt" | tail -3
case $G in
  0) ;;
  3) step "the health gate says something got worse for users: nothing deployed. Read the full report (cloud-health/tools/health-prod-job.sh) first"; exit 3 ;;
  *) refuse "the health report could not be read (exit $G): not deploying without the gate" ;;
esac

# --- deploy-prod.sh, unchanged (its own gate again, migrations, identity, vault, propagation) ---
[ "$(left)" -ge 240 ] || refuse "only $(left) s left before the rollback reserve: not starting a deploy that may not finish"
step "2. scripts/deploy-prod.sh"
(cd "$CLOUD" && timeout -k 10 $(( $(left) > 60 ? $(left) : 60 )) bash scripts/deploy-prod.sh) > "$EVID/deploy-prod.txt" 2>&1; DEP=$?
grep -E "^health|STOP|WARNING|Migrat|No migrations|Uploaded|Deployed|New version live|ERROR|shim:" "$EVID/deploy-prod.txt" | cut -c1-160 | tee -a "$EVID/log.txt"
if [ $DEP != 0 ] && grep -q '^STOP: the health report' "$EVID/deploy-prod.txt" && ! grep -q '^Uploaded ' "$EVID/deploy-prod.txt"; then
  step "deploy-prod.sh's own gate stopped it before any change: nothing deployed"; exit 3
fi
# Killed by its timeout, or no time left: roll back now, without spending the reserve on reads.
if [ $DEP != 0 ] && { [ $DEP = 124 ] || [ $DEP = 137 ] || [ "$(left)" -le 0 ]; }; then
  grep -q '^Uploaded ' "$EVID/deploy-prod.txt" || { step "deploy-prod.sh stopped (exit $DEP) before any upload: nothing to roll back"; exit 1; }
  rollback "deploy-prod.sh was stopped (exit $DEP) with $(( $(left) + KEY_MARGIN_S )) s of the window left"
fi
read -r NV NI <<<"$(lives)"; [ "$NV" = - ] && NV=""; [ "$NI" = - ] && NI=""
echo "after deploy-prod.sh (exit $DEP): vault ${NV:-?}, identity ${NI:-?}" | tee -a "$EVID/log.txt"
if [ $DEP != 0 ]; then
  if [ "$NV" = "$OLD_VAULT" ] && [ "$NI" = "$OLD_ID" ] && ! grep -q '^Uploaded ' "$EVID/deploy-prod.txt"; then
    step "deploy-prod.sh failed before any worker changed (D1 migrations may have applied: additive). Nothing to roll back"; exit 1
  fi
  # Only "the edge has not moved yet" earns more time: both workers new, and the edge still serving the OLD version.
  if [ -n "$NV" ] && [ -n "$NI" ] && [ "$NV" != "$OLD_VAULT" ] && [ "$NI" != "$OLD_ID" ] && { E1="$(edge)"; [ "$E1" = "$OLD_ID" ] || [ "$E1" = "$NI" ]; } \
     && grep -q 'still reports the PRE-deploy version' "$EVID/deploy-prod.txt"; then
    step "both workers are on new versions; only the edge wait ran out (edge now ${E1:-?}). Waiting up to 120 s more"
    wait_edge "$NI" 120 || rollback "the edge does not serve $NI after the extra wait"
  else
    rollback "deploy-prod.sh failed (exit $DEP) with vault ${NV:-?} / identity ${NI:-?}"
  fi
fi
DV="$(awk '$1=="parachute-vault-do"{v=$2} END{print v}' "$DEPLOYED_LOG")"; DI="$(awk '$1=="parachute-identity"{v=$2} END{print v}' "$DEPLOYED_LOG")"
[ -n "$NV" ] && [ "$NV" = "$DV" ] || rollback "vault is on ${NV:-?}, not the version this job uploaded (${DV:-none})"
[ -n "$NI" ] && [ "$NI" = "$DI" ] || rollback "identity is on ${NI:-?}, not the version this job uploaded (${DI:-none})"
wait_edge "$NI" 90 || rollback "the edge does not serve $NI"
echo "deployed: parachute-vault-do $NV, parachute-identity $NI (edge $NI)" | tee "$EVID/versions-after.txt"

# --- read-only checks, then smoke-prod ---
step "3. read-only checks"
C="$EVID/checks.txt"; : > "$C"
chk() { echo "$1 -> $2" | tee -a "$C"; [ "$2" = "$3" ] || rollback "$1 answered '$2', not '$3'"; }
for d in "" /file /status /read-token /finish /abort; do
  c=""; for i in $(seq 1 10); do c="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$ISSUER/ops/vault-import$d")"; [ "$c" = 401 ] || [ "$(left)" -le 0 ] && break; sleep 3; done
  chk "POST /ops/vault-import$d without a bearer" "$c" 401
done
oh="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$ISSUER/ops/health")"   # 404 while its token is unset, 401 once set
chk "GET /ops/health without a bearer (401 or 404)" "$([ "$oh" = 401 ] || [ "$oh" = 404 ] && echo refused || echo "$oh")" refused
wk="$(curl -s --max-time 10 "$MY/.well-known/parachute-account" | python3 -I -c 'import json,sys
j=json.load(sys.stdin); c=json.dumps(j.get("capabilities",j))
print(j.get("billing_mode"), "account_delete" in c and "connections" in c)' 2>/dev/null)"
chk "my. well-known billing_mode, delete+connections" "$wk" "open_beta True"
chk "cloud. authorize" "$(curl -s --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' "$ISSUER/oauth/authorize?client_id=probe&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&code_challenge=x&code_challenge_method=S256" | cut -d'?' -f1)" "302 $MY/oauth/authorize"
chk "u. /health" "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$VH/health")" 200
chk "import-status without a token" "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$VH/vault/t413-probe-none/api/internal/import-status")" 401
chk "browser GET /vault/<none>" "$(curl -s --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' -H 'accept: text/html' "$VH/vault/t413-probe-none")" "302 $MY/v/t413-probe-none"
chk "api GET /vault/<none>" "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H 'accept: application/json' "$VH/vault/t413-probe-none")" 401
chk "POST /__test/health-collect" "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$ISSUER/__test/health-collect?vault=x")" 404
chk "my. /.parachute/info app version" "$(curl -s --max-time 10 "$MY/.parachute/info" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null)" "$SPA_WANT"
L=$(left); step "4. smoke-prod.ts (up to $(( L < 240 ? L : 240 )) s; $L s before only the rollback's time is left)"
[ "$L" -ge 45 ] || rollback "no time left to run smoke-prod inside the key window"
(cd "$CLOUD" && timeout -k 10 "$(( L < 240 ? L : 240 ))" bun scripts/smoke-prod.ts) > "$EVID/smoke-prod.txt" 2>&1 || { tail -4 "$EVID/smoke-prod.txt"; rollback "smoke-prod failed or ran out of time"; }
tail -1 "$EVID/smoke-prod.txt" | tee -a "$C"
echo "rollback targets if needed later: vault $OLD_VAULT / identity $OLD_ID (wrangler rollback <id> --name <worker>)" | tee -a "$C"
step "shipped: cloud ${WANT:0:7} on production, checks + smoke-prod passed"
