#!/usr/bin/env bash
# External uptime check for Parachute Cloud — runs OUTSIDE Cloudflare (today
# GitHub Actions, .github/workflows/uptime.yml; the plan to move it to a
# scheduler that keeps time is docs/UPTIME.md), because the identity worker's
# own 10-minute health cron goes silent exactly when that worker is down.
#
# Read-only: one GET per URL (plus retries), and the optional canary below.
#
# Usage: scripts/uptime-check.sh [URL ...]
#   With no arguments, checks the production health endpoints below.
#   A URL passes when it answers HTTP 200 with a JSON body containing
#   "status":"ok" (both workers' /health shape). Each URL gets ATTEMPTS tries,
#   RETRY_DELAY seconds apart, TIMEOUT seconds each — so one blip is not an
#   outage.
#
# CANARY (L6-03): /health is router-level and never wakes a vault's Durable
# Object, so a DO that fails to boot passes it. With both of these set, the
# check also reads the canary vault the way a client does:
#   CANARY_TOKEN_URL  the identity worker's POST /ops/canary-token, e.g.
#                     https://my.parachute.computer/ops/canary-token
#   CANARY_OPS_TOKEN  its bearer (the value of the identity secret OPS_CANARY_TOKEN)
# It gets a 5-minute read-only token for the canary vault, then makes one REST
# note read and one MCP tools/list against the vault URL that came with it.
# Either unset → the canary is skipped (one line in the report; exit unaffected).
# Needs jq. The tokens are passed to curl in a 0600 header file, never argv.
#
# Output: a short Markdown report on stdout (used as the issue body/comment).
# Exit:   0 when every check passed, 1 when any failed.
set -uo pipefail

ATTEMPTS="${ATTEMPTS:-3}"
RETRY_DELAY="${RETRY_DELAY:-20}"
TIMEOUT="${TIMEOUT:-15}"

if [ "$#" -gt 0 ]; then
  URLS=("$@")
else
  URLS=(
    "https://my.parachute.computer/health"    # identity worker (the canonical human origin)
    "https://cloud.parachute.computer/health" # identity worker (legacy console front door)
    "https://u.parachute.computer/health"     # vault worker (router-level, never wakes a DO)
  )
fi

now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# One line, bounded: a reason, never a body dump.
oneline() { tr -s '\r\n\t' '   ' | head -c "${1:-200}"; }

# "HTTP 500 Internal server error (NewerSchemaError: …)" from a vault error body.
http_reason() { # code body_file
  local said
  said="$(jq -r '[(.error | if type == "string" then . elif . == null then empty else tojson end), (.detail // empty | "(\(.))")] | join(" ")' "$2" 2>/dev/null || head -c 200 "$2")"
  printf 'HTTP %s %s' "$1" "$said" | oneline 200
}

# One canary attempt. Prints "ok" or the failing step and why.
canary_once() {
  local dir="$1" code tok vault_url note note_enc
  printf 'authorization: Bearer %s\n' "$CANARY_OPS_TOKEN" > "$dir/ops.h"
  code="$(curl -sS -o "$dir/tok.json" -w '%{http_code}' --max-time "$TIMEOUT" -X POST -H @"$dir/ops.h" "$CANARY_TOKEN_URL" 2>"$dir/err")" \
    || { printf 'token: curl error: %s' "$(oneline 200 < "$dir/err")"; return; }
  [ "$code" = "200" ] || { printf 'token: %s' "$(http_reason "$code" "$dir/tok.json")"; return; }
  tok="$(jq -r '.vault_token // empty' "$dir/tok.json")"
  vault_url="$(jq -r '.vault_url // empty' "$dir/tok.json")"
  note="$(jq -r '.note // empty' "$dir/tok.json")"
  [ -n "$tok" ] && [ -n "$vault_url" ] && [ -n "$note" ] || { printf 'token: HTTP 200 without vault_token/vault_url/note'; return; }
  printf 'authorization: Bearer %s\n' "$tok" > "$dir/vault.h"
  note_enc="$(jq -rn --arg s "$note" '$s|@uri')"

  code="$(curl -sS -o "$dir/note.json" -w '%{http_code}' --max-time "$TIMEOUT" -H @"$dir/vault.h" -H 'accept: application/json' \
    "$vault_url/api/notes/$note_enc" 2>"$dir/err")" || { printf 'note read: curl error: %s' "$(oneline 200 < "$dir/err")"; return; }
  [ "$code" = "200" ] || { printf 'note read: %s' "$(http_reason "$code" "$dir/note.json")"; return; }
  jq -e '.id | type == "string"' "$dir/note.json" >/dev/null 2>&1 || { printf 'note read: HTTP 200 but no note in the body'; return; }

  code="$(curl -sS -o "$dir/mcp.out" -w '%{http_code}' --max-time "$TIMEOUT" -X POST -H @"$dir/vault.h" \
    -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$vault_url/mcp" 2>"$dir/err")" \
    || { printf 'mcp tools/list: curl error: %s' "$(oneline 200 < "$dir/err")"; return; }
  [ "$code" = "200" ] || { printf 'mcp tools/list: %s' "$(http_reason "$code" "$dir/mcp.out")"; return; }
  # JSON, or SSE: the JSON-RPC message is the first `data:` line.
  if grep -q '^data:' "$dir/mcp.out"; then sed -n 's/^data: *//p' "$dir/mcp.out" | head -n 1 > "$dir/mcp.json"; else cp "$dir/mcp.out" "$dir/mcp.json"; fi
  if jq -e '.error' "$dir/mcp.json" >/dev/null 2>&1; then
    printf 'mcp tools/list: JSON-RPC error %s' "$(jq -c '.error' "$dir/mcp.json" | oneline 160)"; return
  fi
  jq -e '(.result.tools | type == "array") and (.result.tools | length > 0)' "$dir/mcp.json" >/dev/null 2>&1 \
    || { printf 'mcp tools/list: HTTP 200 but no tools listed'; return; }
  printf 'ok'
}

failed=0
rows=()
for url in "${URLS[@]}"; do
  result=""
  for attempt in $(seq 1 "$ATTEMPTS"); do
    body_file="$(mktemp)"
    code="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time "$TIMEOUT" -H 'accept: application/json' "$url" 2>"$body_file.err")"
    curl_rc=$?
    body="$(head -c 300 "$body_file" | tr -d '\r\n')"
    err="$(head -c 200 "$body_file.err" | tr -d '\r\n')"
    rm -f "$body_file" "$body_file.err"
    if [ "$curl_rc" -eq 0 ] && [ "$code" = "200" ] && printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      result="ok"
      break
    fi
    if [ "$curl_rc" -ne 0 ]; then
      result="curl error ${curl_rc}: ${err}"
    elif [ "$code" != "200" ]; then
      result="HTTP ${code}"
    else
      result="unexpected body: ${body}"
    fi
    if [ "$attempt" -lt "$ATTEMPTS" ]; then sleep "$RETRY_DELAY"; fi
  done
  if [ "$result" = "ok" ]; then
    rows+=("| ${url} | ok |")
  else
    failed=1
    rows+=("| ${url} | **DOWN** — ${result} (after ${ATTEMPTS} tries) |")
  fi
done

canary_note=""
if [ -z "${CANARY_TOKEN_URL:-}" ] || [ -z "${CANARY_OPS_TOKEN:-}" ]; then
  canary_note="Canary vault: skipped (CANARY_TOKEN_URL / CANARY_OPS_TOKEN unset)."
elif ! command -v jq >/dev/null 2>&1; then
  failed=1
  rows+=("| canary vault (note read + MCP tools/list) | **DOWN** — jq is not installed, cannot check |")
else
  canary_dir="$(mktemp -d)"
  chmod 700 "$canary_dir"
  trap 'rm -rf "$canary_dir"' EXIT
  result=""
  for attempt in $(seq 1 "$ATTEMPTS"); do
    result="$(umask 077; canary_once "$canary_dir")"
    [ "$result" = "ok" ] && break
    if [ "$attempt" -lt "$ATTEMPTS" ]; then sleep "$RETRY_DELAY"; fi
  done
  rm -rf "$canary_dir"
  if [ "$result" = "ok" ]; then
    rows+=("| canary vault (note read + MCP tools/list) | ok |")
  else
    failed=1
    rows+=("| canary vault (note read + MCP tools/list) | **DOWN** — ${result} (after ${ATTEMPTS} tries) |")
  fi
fi

if [ "$failed" -eq 1 ]; then
  echo "Parachute Cloud uptime check **failed** at $(now)."
else
  echo "Parachute Cloud uptime check **passed** at $(now)."
fi
echo
echo "| Endpoint | Result |"
echo "|---|---|"
printf '%s\n' "${rows[@]}"
echo
if [ -n "$canary_note" ]; then echo "$canary_note"; echo; fi
echo "Checked from outside Cloudflare (${CHECKED_FROM:-GitHub Actions}) with read-only requests, ${ATTEMPTS} tries each."
exit "$failed"
