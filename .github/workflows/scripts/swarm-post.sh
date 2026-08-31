#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || ! $2 =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <run-id> <pr-number>" >&2
  exit 2
fi

run_id=$1
pr_number=$2

agent-relay cloud sync "$run_id"

declare -A verdicts
for lens in maintainability history structure; do
  mapfile -t transcripts < <(
    find ops/reviews -maxdepth 1 -type f -name "*-pr${pr_number}-${lens}.md" -printf '%T@ %p\n' |
      sort -nr | cut -d' ' -f2-
  )
  if [[ ${#transcripts[@]} -eq 0 ]]; then
    echo "missing $lens transcript for PR #$pr_number" >&2
    exit 1
  fi

  transcript=${transcripts[0]}
  if grep -q 'REVIEW_FAILED' "$transcript"; then
    verdicts[$lens]=FAILED
  elif grep -q 'REVIEW_PASSED' "$transcript"; then
    verdicts[$lens]=PASSED
  else
    echo "$transcript has no review verdict" >&2
    exit 1
  fi
  gh pr comment "$pr_number" --body-file "$transcript"
done

logs=$(agent-relay cloud logs "$run_id")
if grep -q 'SWARM_PASSED' <<<"$logs"; then
  aggregate=PASSED
elif grep -q 'SWARM_FAILED' <<<"$logs"; then
  aggregate=FAILED
else
  echo "cloud log has no aggregate swarm verdict" >&2
  exit 1
fi

marker="🎯 review-swarm: $aggregate (M:${verdicts[maintainability]} H:${verdicts[history]} S:${verdicts[structure]})"
gh pr comment "$pr_number" --body "$marker"

[[ $aggregate == PASSED ]]
