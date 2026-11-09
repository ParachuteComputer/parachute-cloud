#!/usr/bin/env bash
# check-triggers.sh <cloud checkout> <live ref> <new ref>: exit 0 only if both workers' routes, custom domains, cron
# triggers and Durable Object migrations are the same at both refs. The bunx shim deploys with `versions upload` +
# `versions deploy`, which never touch those: if one changed, the shim would ship code without it. Prints what differs.
set -uo pipefail
C="${1:?checkout}"; A="${2:?live ref}"; B="${3:?new ref}"; rc=0
pick() { git -C "$C" show "$1:workers/$2/wrangler.toml" | grep -vE '^\s*#' | grep -E 'crons|routes|pattern|custom_domain|zone_name|zone_id|new_sqlite_classes|new_classes|deleted_classes|renamed_classes|transferred_classes|^\s*tag\s*=|^\[\[?(env\.staging\.)?(triggers|migrations|routes)'; }
for w in vault identity; do
  if ! diff <(pick "$A" $w) <(pick "$B" $w) > /dev/null; then
    echo "triggers/routes/migrations differ for $w between ${A:0:7} and ${B:0:7}:"; diff <(pick "$A" $w) <(pick "$B" $w); rc=1
  else echo "$w: routes, domains, crons and DO migrations unchanged (${A:0:7} -> ${B:0:7}; $(pick "$B" $w | wc -l) lines compared)"; fi
done
exit $rc
