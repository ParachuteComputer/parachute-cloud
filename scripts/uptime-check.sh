#!/usr/bin/env bash
# External uptime check for Parachute Cloud — runs OUTSIDE Cloudflare (GitHub
# Actions, .github/workflows/uptime.yml), because the identity worker's own
# 10-minute health cron goes silent exactly when that worker is down.
#
# Read-only: one GET per URL (plus retries). No secrets.
#
# Usage: scripts/uptime-check.sh [URL ...]
#   With no arguments, checks the production health endpoints below.
#   A URL passes when it answers HTTP 200 with a JSON body containing
#   "status":"ok" (both workers' /health shape). Each URL gets ATTEMPTS tries,
#   RETRY_DELAY seconds apart, TIMEOUT seconds each — so one blip is not an
#   outage.
#
# Output: a short Markdown report on stdout (used as the issue body/comment).
# Exit:   0 when every URL passed, 1 when any failed.
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
echo "Checked from outside Cloudflare (GitHub Actions) with read-only GETs, ${ATTEMPTS} tries each."
exit "$failed"
