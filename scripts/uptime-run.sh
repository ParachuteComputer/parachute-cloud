#!/usr/bin/env bash
# One external uptime run, for a scheduler outside GitHub (docs/UPTIME.md):
# scripts/uptime-check.sh (production /health + the canary vault), then
# scripts/uptime-issue.sh (open, comment on or close the ONE `uptime` issue).
# The same two steps .github/workflows/uptime.yml runs.
#
# Needs: curl, jq, gh. Env: GH_TOKEN (issues: write on this repo only),
# GITHUB_REPOSITORY (ParachuteComputer/parachute-cloud), and for the canary
# CANARY_TOKEN_URL + CANARY_OPS_TOKEN (see uptime-check.sh). CHECKED_FROM names
# the box in the report.
# Exit: 0 when production is up, 1 when it is down, 2 when the issue step failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
report="$(mktemp)"
trap 'rm -f "$report"' EXIT

bash "$HERE/uptime-check.sh" > "$report"
if [ "$?" -eq 0 ]; then state=up; else state=down; fi
cat "$report"
bash "$HERE/uptime-issue.sh" "$state" "$report" || exit 2
[ "$state" = up ]
