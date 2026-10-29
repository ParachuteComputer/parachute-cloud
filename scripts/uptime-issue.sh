#!/usr/bin/env bash
# Open, update or close the ONE GitHub issue that tracks a production outage
# (labelled `uptime`). Called by .github/workflows/uptime.yml after
# scripts/uptime-check.sh. Needs `gh` with GH_TOKEN (issues: write) and
# GITHUB_REPOSITORY.
#
# Usage: scripts/uptime-issue.sh <down|up> <report.md> [run-url]
#   down + no open issue   → create one (label `uptime`) with the report.
#   down + open issue      → comment the report on it (a timeline of the outage).
#   up   + open issue      → comment "recovered" and close it.
#   up   + no open issue   → nothing.
# Dedupe is by searching OPEN issues with the `uptime` label, so at most one
# outage issue is open at a time.
set -euo pipefail

state="${1:?usage: uptime-issue.sh <down|up> <report.md> [run-url]}"
report="${2:?usage: uptime-issue.sh <down|up> <report.md> [run-url]}"
run_url="${3:-}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
label="uptime"

footer=""
if [ -n "$run_url" ]; then footer=$'\n\n'"Run: ${run_url}"; fi

existing="$(gh issue list --repo "$repo" --label "$label" --state open --limit 1 --json number --jq '.[0].number // empty')"

case "$state" in
  down)
    if [ -n "$existing" ]; then
      gh issue comment "$existing" --repo "$repo" --body "$(cat "$report")${footer}"
      echo "commented on #${existing}"
    else
      # The label may not exist yet on a fresh repo; creating it is idempotent.
      gh label create "$label" --repo "$repo" --color B60205 \
        --description "Production health check failing (uptime workflow)" >/dev/null 2>&1 || true
      gh issue create --repo "$repo" --label "$label" \
        --title "Uptime: Parachute Cloud production health check failing" \
        --body "$(cat "$report")${footer}"
      echo "opened a new uptime issue"
    fi
    ;;
  up)
    if [ -n "$existing" ]; then
      gh issue comment "$existing" --repo "$repo" --body "Recovered — every endpoint is answering again."$'\n\n'"$(cat "$report")${footer}"
      gh issue close "$existing" --repo "$repo"
      echo "closed #${existing}"
    else
      echo "all green, no open uptime issue"
    fi
    ;;
  *)
    echo "unknown state: $state (want down|up)" >&2
    exit 2
    ;;
esac
