#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || ! $2 =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <run-id> <pr-number>" >&2
  exit 2
fi

run_id=$1
pr_number=$2
agent-relay cloud sync "$run_id"
run_status=$(agent-relay cloud status "$run_id" --json)

declare -A verdicts
for lens in maintainability history structure; do
  transcript=$(find ops/reviews -maxdepth 1 -type f \
    -name "*-pr${pr_number}-${lens}.md" -printf '%T@ %p\n' |
    sort -nr | head -1 | cut -d' ' -f2-)
  if [[ -z $transcript ]]; then
    echo "No $lens transcript found for PR #$pr_number" >&2
    exit 1
  fi

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

if grep -q 'SWARM_PASSED' <<<"$run_status"; then
  aggregate=PASSED
elif grep -q 'SWARM_FAILED' <<<"$run_status"; then
  aggregate=FAILED
else
  echo "Cloud run $run_id has no aggregate swarm verdict" >&2
  exit 1
fi

marker="🎯 review-swarm: $aggregate (M:${verdicts[maintainability]} H:${verdicts[history]} S:${verdicts[structure]})"
gh pr comment "$pr_number" --body "$marker"
echo "$marker"
