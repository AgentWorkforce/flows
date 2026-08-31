#!/usr/bin/env bash
set -euo pipefail

run_id="${1:-}"
pr_number="${2:-}"

if [[ -z "$run_id" || ! "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "usage: bash $0 <runId> <PR-number>" >&2
  exit 64
fi

agent-relay cloud sync "$run_id"
logs=$(agent-relay cloud logs "$run_id")

declare -A verdicts
for lens in maintainability history structure; do
  review=$(find ops/reviews -maxdepth 1 -type f \
    -name "*-pr${pr_number}-${lens}.md" -printf '%T@ %p\n' |
    sort -nr | head -1 | cut -d' ' -f2-)
  if [[ -z "$review" ]]; then
    echo "No $lens review found for PR #$pr_number" >&2
    exit 1
  fi

  if grep -q 'REVIEW_FAILED' "$review"; then
    verdicts[$lens]=FAILED
  elif grep -q 'REVIEW_PASSED' "$review"; then
    verdicts[$lens]=PASSED
  else
    echo "$review has no review verdict" >&2
    exit 1
  fi

  gh pr comment "$pr_number" --body-file "$review"
done

if grep -q 'SWARM_PASSED' <<<"$logs"; then
  swarm_verdict=PASSED
elif grep -q 'SWARM_FAILED' <<<"$logs"; then
  swarm_verdict=FAILED
else
  echo "Cloud run $run_id has no aggregate swarm verdict" >&2
  exit 1
fi

marker="🎯 review-swarm: $swarm_verdict (M:${verdicts[maintainability]} H:${verdicts[history]} S:${verdicts[structure]})"
gh pr comment "$pr_number" --body "$marker"
