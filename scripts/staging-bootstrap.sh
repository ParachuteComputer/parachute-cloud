#!/usr/bin/env bash
#
# staging-bootstrap.sh — stand STAGING up on its own Cloudflare account ("Parachute Staging", T-432) from nothing:
# the D1 and the R2 bucket, every D1 migration, the dev-user seed, both workers, then the secrets. Idempotent: each
# step looks before it makes, so a re-run after a failure picks up where it stopped. Run it once per fresh account;
# after that scripts/deploy-staging.sh is the whole deploy.
#
#   bash scripts/staging-bootstrap.sh [--steps subdomain,r2,d1,deploy,secrets] [--secrets-dir DIR]
#   bash scripts/staging-bootstrap.sh --local STATE_DIR [--secrets-dir DIR]     # rehearsal: no Cloudflare call
#
# Steps, in order (default: all five):
#   subdomain the account's workers.dev subdomain is STAGING_WORKERS_SUBDOMAIN: registered if the account has none,
#            refused if it has another. A direct API call (wrangler has no command for it), so it needs
#            CLOUDFLARE_API_TOKEN in the environment (Workers Scripts Edit on this account); without one it is skipped
#            with a note, and the deploy step's /health check catches a wrong name.
#   r2       the bucket STAGING_R2_BUCKET, unless the account has it. Its own card under the sealed broker: bucket
#            create needs r2-admin, which a staging window never holds (uni-ops sealed/policy.py).
#   d1       the database STAGING_D1_NAME, unless the account has it; its id is then written into
#            scripts/staging-account.env and workers/identity/wrangler.toml [env.staging.d1_databases]. Commit that.
#   deploy   scripts/deploy-staging.sh: vault worker, every migration, the dev-user seed, identity worker, the edge
#            wait. Needs workers/identity/.dev-secrets (the caller puts it there; see deploy-staging.sh). Then
#            checks both workers answer /health on the account's workers.dev subdomain.
#   secrets  every file in --secrets-dir named after a secret below is set on its worker with `wrangler secret bulk`
#            (values go through a 0600 temp file, never argv or the log; only names are printed). Names missing from
#            the dir are listed and skipped: each one is optional in the code. A live-mode Stripe key is refused.
#
# --local STATE_DIR: the same steps against miniflare state in STATE_DIR (wrangler --local / --persist-to): migrations,
# the seed, both workers' staging config bundled (deploy --dry-run), both workers started with `wrangler dev --env
# staging`, /health on each, and the secrets proven by the ops door answering their bearer. Nothing leaves the box.
#
# The account comes from scripts/staging-account.env, never the caller's environment. Nothing secret is printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/scripts/staging-account.env"
# shellcheck source=staging-account.env
. "$ENV_FILE"
export CLOUDFLARE_ACCOUNT_ID="$STAGING_ACCOUNT_ID" WRANGLER_SEND_METRICS=false
PLACEHOLDER=00000000-0000-0000-0000-000000000000
IDENTITY_TOML="$ROOT/workers/identity/wrangler.toml"
IDENTITY_HOST="parachute-identity-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev"
VAULT_HOST="parachute-vault-do-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev"

# Secrets by worker. Names only; every one is optional in the code (workers/*/src/env.ts). The Stripe pair is set only if
# the dir has it (staging walks the open beta, where checkout is dormant even with keys) and only in test mode.
IDENTITY_SECRETS="OPS_RUN_TOKEN OPS_READ_TOKEN OPS_DELETE_TOKEN OPS_CANARY_TOKEN OPS_ALERT_WEBHOOK_URL STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET"
VAULT_SECRETS="VAULT_AUTH_TOKEN"

STEPS="subdomain,r2,d1,deploy,secrets"; SECRETS_DIR=""; LOCAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --steps) STEPS="${2:?--steps subdomain,r2,d1,deploy,secrets}"; shift ;;
    --secrets-dir) SECRETS_DIR="$(cd "${2:?--secrets-dir DIR}" && pwd)"; shift ;;
    --local) LOCAL="$(mkdir -p "${2:?--local STATE_DIR}" && cd "$2" && pwd)"; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac; shift
done
for s in ${STEPS//,/ }; do case "$s" in subdomain|r2|d1|deploy|secrets) ;; *) echo "unknown step: $s" >&2; exit 2 ;; esac; done
want() { case ",$STEPS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
say() { echo "== $*"; }
die() { echo "refused: $*" >&2; exit 2; }

[[ "$STAGING_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || die "STAGING_ACCOUNT_ID in $ENV_FILE is not 32 hex"
[[ "$STAGING_WORKERS_SUBDOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "STAGING_WORKERS_SUBDOMAIN is not a subdomain label"
# Under the sealed broker the job's key works on one account only: it must be this one.
if [ -n "${UNI_SEALED_ACCOUNT_ID:-}" ] && [ "$UNI_SEALED_ACCOUNT_ID" != "$STAGING_ACCOUNT_ID" ]; then
  die "the sealed job is on account ${UNI_SEALED_ACCOUNT_ID:0:8}…, not Parachute Staging (${STAGING_ACCOUNT_ID:0:8}…)"
fi

# Writes the D1 id into the env file and into [env.staging.d1_databases] of the identity wrangler.toml (the one
# database_id line inside that block; the production block above it is never touched).
write_d1_id() {
  local id="$1" tmp
  [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "D1 id '$id' is not a uuid"
  tmp="$(mktemp)"
  awk -v id="$id" '
    /^\[\[env\.staging\.d1_databases\]\]/ { blk = 1 }
    /^\[/ && !/^\[\[env\.staging\.d1_databases\]\]/ { blk = 0 }
    blk && /^database_id = / { print "database_id = \"" id "\""; n++; next }
    { print }
    END { if (n != 1) exit 3 }' "$IDENTITY_TOML" > "$tmp" || { rm -f "$tmp"; die "no single database_id in [[env.staging.d1_databases]]"; }
  cat "$tmp" > "$IDENTITY_TOML"; rm -f "$tmp"
  sed -i "s/^STAGING_D1_ID=.*/STAGING_D1_ID=$id/" "$ENV_FILE"
  STAGING_D1_ID="$id"
}

# --- subdomain ----------------------------------------------------------------------------------------------------
# The token goes to curl as a header file on a pipe, never on argv. The response holds no secret.
cf_subdomain() {   # cf_subdomain GET|PUT: prints the account's workers.dev subdomain after the call, or nothing
  local body=()
  [ "$1" = PUT ] && body=(-H "content-type: application/json" --data "{\"subdomain\":\"$STAGING_WORKERS_SUBDOMAIN\"}")
  curl -s -X "$1" "${CF_API:-https://api.cloudflare.com/client/v4}/accounts/$STAGING_ACCOUNT_ID/workers/subdomain" \
    -H @<(printf 'authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") "${body[@]}" \
    | bun -e 'const t = await Bun.stdin.text(); let j; try { j = JSON.parse(t); } catch { process.exit(3); }
              if (j.success && j.result?.subdomain) { console.log(j.result.subdomain); process.exit(0); }
              const codes = (j.errors ?? []).map((e) => e.code); console.error("cloudflare:", JSON.stringify(j.errors ?? []).slice(0, 200));
              process.exit(codes.includes(10007) ? 0 : 4);'
}
if want subdomain && [ -z "$LOCAL" ]; then
  say "subdomain: $STAGING_WORKERS_SUBDOMAIN.workers.dev on Parachute Staging"
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "   skipped: no CLOUDFLARE_API_TOKEN here (set the name in the dashboard; deploy's /health check proves it)"
  else
    have="$(cf_subdomain GET)" || die "could not read the account's workers.dev subdomain"
    if [ "$have" = "$STAGING_WORKERS_SUBDOMAIN" ]; then echo "   already set"
    elif [ -n "$have" ]; then die "the account's workers.dev subdomain is '$have', not '$STAGING_WORKERS_SUBDOMAIN': set STAGING_WORKERS_SUBDOMAIN and the [env.staging.vars] URLs to it (or rename it in the dashboard)"
    else
      have="$(cf_subdomain PUT)" || die "could not register $STAGING_WORKERS_SUBDOMAIN.workers.dev (taken, or the key lacks Workers Scripts Edit)"
      [ "$have" = "$STAGING_WORKERS_SUBDOMAIN" ] || die "registered '$have', not '$STAGING_WORKERS_SUBDOMAIN'"
      echo "   registered"
    fi
  fi
fi

# --- r2 ---------------------------------------------------------------------------------------------------------
if want r2 && [ -z "$LOCAL" ]; then
  say "r2: bucket $STAGING_R2_BUCKET on Parachute Staging"
  list="$(cd "$ROOT/workers/vault" && bunx wrangler r2 bucket list)" || die "r2 bucket list failed"
  if echo "$list" | grep -qE "^name:[[:space:]]+$STAGING_R2_BUCKET\$"; then
    echo "   already there"
  else
    (cd "$ROOT/workers/vault" && bunx wrangler r2 bucket create "$STAGING_R2_BUCKET") >/dev/null || die "r2 bucket create failed"
    echo "   created"
  fi
elif want r2; then
  say "r2: local (miniflare makes the bucket on first use)"
fi

# --- d1 ---------------------------------------------------------------------------------------------------------
d1_id_on_account() {   # the id of STAGING_D1_NAME on the account, or nothing
  (cd "$ROOT/workers/identity" && bunx wrangler d1 list --json) \
    | bun -e 'const want = process.argv[1]; const t = await Bun.stdin.text(); const s = t.indexOf("[");
              const rows = s < 0 ? [] : JSON.parse(t.slice(s)); const r = rows.find((d) => d.name === want);
              if (r) console.log(r.uuid);' "$STAGING_D1_NAME"
}
if want d1 && [ -z "$LOCAL" ]; then
  say "d1: database $STAGING_D1_NAME on Parachute Staging"
  have="$(d1_id_on_account)" || die "d1 list failed"
  if [ -z "$have" ]; then
    [ "$STAGING_D1_ID" = "$PLACEHOLDER" ] || die "staging-account.env names D1 $STAGING_D1_ID, which the account does not have: fix the file by hand"
    (cd "$ROOT/workers/identity" && bunx wrangler d1 create "$STAGING_D1_NAME") >/dev/null || die "d1 create failed"
    have="$(d1_id_on_account)" || die "d1 list failed"
    [ -n "$have" ] || die "d1 create returned, but the list does not show $STAGING_D1_NAME"
    echo "   created $have"
  else
    echo "   already there: $have"
  fi
  if [ "$STAGING_D1_ID" != "$have" ]; then
    [ "$STAGING_D1_ID" = "$PLACEHOLDER" ] || die "staging-account.env has D1 $STAGING_D1_ID, the account has $have: fix the file by hand"
    write_d1_id "$have"
    echo "   wrote the id into scripts/staging-account.env + workers/identity/wrangler.toml: commit both"
  fi
elif want d1; then
  say "d1: local (the id stays as committed: $STAGING_D1_ID)"
fi

# --- secrets file per worker (both modes) -----------------------------------------------------------------------
# secrets_json WORKER_NAMES OUT: a JSON object of the secrets present in SECRETS_DIR, into OUT (0600). Prints names.
secrets_json() {
  local names="$1" out="$2" n f set="" skip=""
  ( umask 077; : > "$out" )
  for n in $names; do
    f="$SECRETS_DIR/$n"
    if [ -s "$f" ]; then
      # Anywhere in the file, not only at its start: the upload trims the value.
      if [ "${n#STRIPE_}" != "$n" ] && grep -qE '(sk|rk)_live_' "$f"; then die "$n holds a live-mode Stripe key: staging takes test mode only"; fi
      set="$set $n"
    else skip="$skip $n"; fi
  done
  SECRETS_DIR="$SECRETS_DIR" bun -e 'const fs = require("node:fs"); const o = {};
    for (const n of process.argv.slice(2)) o[n] = fs.readFileSync(`${process.env.SECRETS_DIR}/${n}`, "utf8").trim();
    fs.writeFileSync(process.argv[1], JSON.stringify(o), { mode: 0o600 });' "$out" $set
  echo "   set:${set:- none}"; echo "   not in the dir (left unset):${skip:- none}"
}

# --- remote: deploy + secrets -------------------------------------------------------------------------------------
health_200() {   # health_200 URL: waits up to 90 s for a 200 (a new workers.dev host takes a moment)
  local i code
  for i in $(seq 1 30); do
    code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$1" || true)"
    [ "$code" = 200 ] && return 0
    sleep 3
  done
  echo "   $1 answered ${code:-nothing}" >&2; return 1
}
if [ -z "$LOCAL" ]; then
  if want deploy; then
    say "deploy: scripts/deploy-staging.sh on Parachute Staging"
    [ -s "$ROOT/workers/identity/.dev-secrets" ] || die "no workers/identity/.dev-secrets (the made-up dev user deploy-staging.sh seeds)"
    bash "$ROOT/scripts/deploy-staging.sh" \
      || die "deploy-staging.sh failed. If wrangler named the CPU limit ([limits] cpu_ms, inherited from production), the account needs Workers Paid"
    for h in "$VAULT_HOST" "$IDENTITY_HOST"; do
      health_200 "https://$h/health" || die "https://$h/health is not 200: is the account's workers.dev subdomain '$STAGING_WORKERS_SUBDOMAIN'?"
      echo "   https://$h/health 200"
    done
  fi
  if want secrets; then
    [ -n "$SECRETS_DIR" ] || die "the secrets step needs --secrets-dir DIR (files named after each secret)"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    for w in identity vault; do
      say "secrets: $w (parachute-$( [ $w = vault ] && echo vault-do || echo identity )-staging)"
      names="$IDENTITY_SECRETS"; [ $w = vault ] && names="$VAULT_SECRETS"
      secrets_json "$names" "$tmp/$w.json"
      if [ "$(cat "$tmp/$w.json")" != "{}" ]; then
        # wrangler prints names and counts here, never values.
        out="$(cd "$ROOT/workers/$w" && bunx wrangler secret bulk "$tmp/$w.json" --env staging 2>&1)" \
          || { echo "$out" | grep -E "ERROR|✘" | head -3 >&2; rm -f "$tmp/$w.json"; die "wrangler secret bulk failed for $w"; }
        echo "$out" | grep -E "Success|Finished|✨" | head -3 || true
      fi
      rm -f "$tmp/$w.json"
    done
  fi
  say "staging bootstrap done: https://$IDENTITY_HOST (console) and https://$VAULT_HOST/vault/<name>/"
  exit 0
fi

# --- local rehearsal ----------------------------------------------------------------------------------------------
export CI=1   # wrangler never prompts here
LOGS="$LOCAL/logs"; mkdir -p "$LOGS"
# Local secrets are proven only by the running workers (the deploy step), so they never run alone.
if want secrets && ! want deploy; then die "--local proves secrets only together with the deploy step"; fi
# Each wrangler dev runs in its own process group (setsid): cleanup ends the whole group, workerd included.
PIDS=""; cleanup() { for p in $PIDS; do kill -- "-$p" 2>/dev/null || true; done; rm -f "$LOCAL"/*.vars; }
trap cleanup EXIT
if want deploy; then
  say "deploy (local): migrations, seed, both staging configs bundled"
  (cd "$ROOT/workers/identity" && bunx wrangler d1 migrations apply "$STAGING_D1_NAME" --local --env staging --persist-to "$LOCAL") > "$LOGS/migrate.txt" 2>&1 \
    || { tail -5 "$LOGS/migrate.txt" >&2; die "local migrations failed"; }
  applied="$(cd "$ROOT/workers/identity" && bunx wrangler d1 execute "$STAGING_D1_NAME" --local --env staging --persist-to "$LOCAL" --json \
    --command "SELECT COUNT(*) AS n FROM d1_migrations" 2>/dev/null | bun -e 'const t=await Bun.stdin.text(); console.log(JSON.parse(t.slice(t.indexOf("[")))[0].results[0].n)')" \
    || die "could not count the applied migrations"
  total="$(ls "$ROOT/workers/identity/migrations"/*.sql | wc -l)"
  echo "   migrations applied: $applied of $total"
  [ "$applied" = "$total" ] || die "only $applied of $total migrations applied"
  if [ -s "$ROOT/workers/identity/.dev-secrets" ]; then
    (cd "$ROOT/workers/identity" && bun scripts/seed-dev-user.ts >/dev/null \
      && bunx wrangler d1 execute "$STAGING_D1_NAME" --local --env staging --persist-to "$LOCAL" --command="$(cat scripts/seed-dev-user.sql)" > "$LOGS/seed.txt" 2>&1 \
      && rm -f scripts/seed-dev-user.sql) || die "local seed failed (see $LOGS/seed.txt)"
    echo "   dev user seeded"
  else
    echo "   no workers/identity/.dev-secrets: seed skipped"
  fi
  for w in vault identity; do
    (cd "$ROOT/workers/$w" && bunx wrangler deploy --dry-run --env staging --outdir "$LOCAL/dry-$w") > "$LOGS/dry-$w.txt" 2>&1 \
      || { tail -5 "$LOGS/dry-$w.txt" >&2; die "$w staging config does not bundle"; }
    echo "   $w: bundles; $(grep -cE 'Environment Variable|Durable Object|R2 Bucket|D1 Database|Worker\b' "$LOGS/dry-$w.txt") bindings"
  done
fi
if want secrets; then
  say "secrets (local): into each worker's dev vars"
  for w in identity vault; do
    names="$IDENTITY_SECRETS"; [ $w = vault ] && names="$VAULT_SECRETS"
    if [ -n "$SECRETS_DIR" ]; then
      secrets_json "$names" "$LOCAL/$w.json"
      bun -e 'const o = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        require("node:fs").writeFileSync(process.argv[2], Object.entries(o).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });' \
        "$LOCAL/$w.json" "$LOCAL/$w.vars"
      rm -f "$LOCAL/$w.json"
    else : > "$LOCAL/$w.vars"; fi
  done
fi
if want deploy; then
  say "run (local): both staging workers under wrangler dev"
  free_port() { bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true);'; }
  VP="$(free_port)"; IP="$(free_port)"
  for w in vault identity; do
    port="$VP"; [ $w = identity ] && port="$IP"
    envf=(); [ -f "$LOCAL/$w.vars" ] && envf=(--env-file "$LOCAL/$w.vars")
    (cd "$ROOT/workers/$w" && exec setsid bunx wrangler dev --env staging --local --persist-to "$LOCAL" --ip 127.0.0.1 --port "$port" \
      --inspector-port 0 "${envf[@]}" --show-interactive-dev-session=false) > "$LOGS/dev-$w.txt" 2>&1 &
    PIDS="$PIDS $!"
  done
  for pair in "vault $VP" "identity $IP"; do
    set -- $pair
    for i in $(seq 1 60); do
      code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$2/health" || true)"; [ "$code" = 200 ] && break; sleep 2
    done
    [ "$code" = 200 ] || { tail -8 "$LOGS/dev-$1.txt" >&2; die "local $1 /health is ${code:-silent}"; }
    echo "   $1 /health 200 (port $2)"
  done
  if want secrets && [ -s "$SECRETS_DIR/OPS_READ_TOKEN" ]; then
    # The secret reached the worker: the ops door answers its bearer and refuses a wrong one.
    good="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H @<(printf 'authorization: Bearer %s\n' "$(cat "$SECRETS_DIR/OPS_READ_TOKEN")") "http://127.0.0.1:$IP/ops/health")"
    bad="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "authorization: Bearer wrong" "http://127.0.0.1:$IP/ops/health")"
    echo "   ops door with OPS_READ_TOKEN: $good; with a wrong bearer: $bad"
    [ "$good" = 200 ] && [ "$bad" = 401 ] || die "the identity worker did not take OPS_READ_TOKEN"
  fi
fi
say "local rehearsal done (state in $LOCAL)"
