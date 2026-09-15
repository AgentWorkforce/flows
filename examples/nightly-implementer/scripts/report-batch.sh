#!/usr/bin/env bash
# report-batch.sh — deterministic batch summary.
#
# Reads the per-issue outcomes from --outcomes (a JSON array produced by
# the batch flow) and emits {delivered, failed, items} on stdout. Counts
# are mechanical: no LLM adjudicates which run "really" succeeded.
set -euo pipefail

outcomes_json=""

while [ $# -gt 0 ]; do
  case "$1" in
    --outcomes) outcomes_json="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$outcomes_json" ] || { echo "--outcomes is required" >&2; exit 2; }

jq -n --argjson items "$outcomes_json" '{
  delivered: ($items | map(select(.outcome == "delivered")) | length),
  failed:    ($items | map(select(.outcome == "failed"))    | length),
  items:     $items
}'
