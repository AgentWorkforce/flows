#!/usr/bin/env bash
# report-blocked.sh — needs_human hand-off for the bounded review loop.
#
# Called by the top-level flow when the repair loop exhausted its budget
# without a green verdict. Emits {outcome: "needs_human", inspectionUrl,
# summary} on stdout — the parent verification asserts outcome === "needs_human"
# so the runner surfaces this as gate-5 hand-off (RFC-0001 flows#251), NOT
# as a bare step_failed. The distinction matters to a human triaging the
# drive queue: needs_human means "we did the work, the reviewers refused";
# step_failed means "we couldn't do the work at all".
set -euo pipefail

issue=""
iterations=""
blockers=""

while [ $# -gt 0 ]; do
  case "$1" in
    --issue) issue="$2"; shift 2 ;;
    --iterations) iterations="$2"; shift 2 ;;
    --blockers) blockers="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$issue" ] || { echo "--issue is required" >&2; exit 2; }
[ -n "$iterations" ] || { echo "--iterations is required" >&2; exit 2; }

inspection_url="https://github.com/AgentWorkforce/flows/issues/${issue}"

# Blockers arrive as a JSON array (produced by aggregate-review.sh). Fold
# them into a single ordered list per iteration, preserved literally so
# the human sees what each lens actually said — no LLM summarization.
blockers_json="${blockers:-[]}"

jq -n \
  --arg issue "$issue" \
  --arg iterations "$iterations" \
  --arg url "$inspection_url" \
  --argjson blockers "$blockers_json" \
  '{outcome: "needs_human",
    issue: $issue,
    iterations: ($iterations | tonumber),
    inspectionUrl: $url,
    summary: "\($iterations) implementation iterations exhausted without unanimous review approval; last-iteration blockers preserved verbatim below.",
    blockers: $blockers}'

# Non-zero exit lets the runner classify this outcome as blocked. The
# structured stdout is journaled either way.
exit 3
