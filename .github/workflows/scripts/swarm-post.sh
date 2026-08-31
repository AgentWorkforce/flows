#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <run-id> <pr-number>" >&2
  exit 2
fi

run_id=$1
pr_number=$2
[[ $pr_number =~ ^[0-9]+$ ]] || {
  echo "PR number must contain only digits" >&2
  exit 2
}

shopt -s nullglob
reviews=(ops/reviews/*-pr"$pr_number"-*.md)
((${#reviews[@]} > 0)) || {
  echo "No review transcripts found for PR #$pr_number (run $run_id)" >&2
  exit 1
}

declare -A verdicts=([maintainability]=MISSING [history]=MISSING [structure]=MISSING)
for review in "${reviews[@]}"; do
  echo "Posting $review for review-swarm run $run_id"
  gh pr comment "$pr_number" --body-file "$review"

  for lens in maintainability history structure; do
    [[ $review == *-"$lens".md ]] || continue
    if grep -q 'REVIEW_FAILED' "$review"; then
      verdicts[$lens]=FAILED
    elif grep -q 'REVIEW_PASSED' "$review"; then
      verdicts[$lens]=PASSED
    else
      verdicts[$lens]=MISSING
    fi
  done
done

result=PASSED
for lens in maintainability history structure; do
  [[ ${verdicts[$lens]} == PASSED ]] || result=FAILED
done

marker="🎯 review-swarm: $result (M:${verdicts[maintainability]} H:${verdicts[history]} S:${verdicts[structure]})"
echo "Posting aggregate marker: $marker"
gh pr comment "$pr_number" --body "$marker"
