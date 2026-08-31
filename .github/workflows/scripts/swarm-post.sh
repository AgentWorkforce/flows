#!/usr/bin/env bash
# Sync a completed cloud review-swarm run and post its transcripts + marker
# back to the PR.
#
# Two load-bearing extraction rules (both hard-won repo history):
#   1. SORT transcripts by FILENAME (starts with YYYYMMDD-HHMM), not by mtime.
#      Fresh checkouts give transcripts uniform mtimes and mtime-sort picked
#      stale verdicts — commit b2535aa fixed this class of bug elsewhere.
#   2. The verdict is the LAST non-empty line's token, not a whole-file grep.
#      A whole-file grep of REVIEW_FAILED misclassifies a passing review that
#      quotes the token in prose — commit f59d9cd fixed this elsewhere too.
# Same for the aggregate: LAST SWARM_ token in the log, not a substring match.
#
# Sticky marker: hidden HTML comment identifies the marker; edit-in-place
# across re-runs so N pushes don't accumulate N marker comments.
set -euo pipefail

run_id=${1:-}
pr_number=${2:-}

[[ "$run_id" =~ ^[[:alnum:]-]+$ ]] || {
  echo "usage: $0 <runId> <PR-number>" >&2
  exit 2
}
[[ "$pr_number" =~ ^[0-9]+$ ]] || {
  echo "usage: $0 <runId> <PR-number>" >&2
  exit 2
}

agent-relay cloud sync "$run_id"
run_log=$(agent-relay cloud logs "$run_id")
printf '%s\n' "$run_log"

# Aggregate: last SWARM_ token in the log (not a substring anywhere).
overall=FAILED
last_swarm=$(printf '%s\n' "$run_log" | grep -Eo 'SWARM_(PASSED|FAILED)' | tail -1 || true)
[[ "$last_swarm" == SWARM_PASSED ]] && overall=PASSED

declare -A verdicts
for lens in maintainability history structure; do
  # Sort lexicographically by filename (YYYYMMDD-HHMM prefix), take newest.
  shopt -s nullglob
  matches=(ops/reviews/*-pr"$pr_number"-"$lens".md)
  shopt -u nullglob
  if ((${#matches[@]} == 0)); then
    echo "missing $lens transcript for PR #$pr_number" >&2
    verdicts[$lens]=MISSING
    continue
  fi
  transcript=$(printf '%s\n' "${matches[@]}" | sort | tail -1)

  # Verdict = last non-empty line's token.
  last_line=$(awk 'NF { last=$0 } END { print last }' "$transcript")
  case "$last_line" in
    *REVIEW_PASSED*) verdicts[$lens]=PASSED ;;
    *REVIEW_FAILED*) verdicts[$lens]=FAILED ;;
    *) verdicts[$lens]=UNCLEAR ;;
  esac

  gh pr comment "$pr_number" --body-file "$transcript"
done

# Compute the aggregate from lens verdicts DIRECTLY, not from cloud logs. The
# logs-derived `overall` above is a first pass but can disagree with the
# actual transcripts (log parsing missed a lens, aggregate step raced, etc).
# The transcripts are the load-bearing evidence — a single FAILED lens means
# aggregate FAILED, per the review-swarm.yaml aggregate step's own rule
# ("any single honest refusal blocks the merge").
#
# Compute aggregate = ALL lenses PASSED; else FAILED. This is fail-closed:
# MISSING, UNCLEAR, FAILED all degrade to FAILED. The prior bug only
# degraded MISSING/UNCLEAR, so a log-derived PASSED could survive even when
# a lens transcript said FAILED.
overall=PASSED
for lens in maintainability history structure; do
  if [[ "${verdicts[$lens]:-MISSING}" != PASSED ]]; then
    overall=FAILED
  fi
done

marker_id='<!-- review-swarm-marker -->'
body="$marker_id"$'\n'"🎯 review-swarm: $overall (M:${verdicts[maintainability]:-MISSING} H:${verdicts[history]:-MISSING} S:${verdicts[structure]:-MISSING})"

# Sticky comment: find existing by identity marker, edit in place.
existing_id=$(gh api "repos/${GITHUB_REPOSITORY:?}/issues/$pr_number/comments" --jq \
  ".[] | select(.body | contains(\"$marker_id\")) | .id" | head -1)

if [[ -n "$existing_id" ]]; then
  gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/$existing_id" \
    -f body="$body" > /dev/null
else
  gh pr comment "$pr_number" --body "$body"
fi
