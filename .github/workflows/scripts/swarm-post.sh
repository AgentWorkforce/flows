#!/bin/sh
set -eu

run_id=${1:-}
pr_number=${2:-}

[ -n "$run_id" ] || { echo "usage: $0 <runId> <PR number>" >&2; exit 2; }
case "$pr_number" in
  ''|*[!0-9]*) echo "PR number must contain digits only" >&2; exit 2 ;;
esac

agent-relay cloud sync "$run_id"

review_dir=ops/reviews
files=$(find "$review_dir" -maxdepth 1 -type f -name "*-pr${pr_number}-*.md" -print | sort)
[ -n "$files" ] || { echo "no review transcripts found for PR #$pr_number" >&2; exit 1; }

for file in $files; do
  gh pr comment "$pr_number" --body-file "$file"
done

failed=0
summary=
for lens in maintainability history structure; do
  file=$(find "$review_dir" -maxdepth 1 -type f -name "*-pr${pr_number}-${lens}.md" -print | sort | tail -1)
  verdict=MISSING
  if [ -n "$file" ] && grep -q 'REVIEW_FAILED' "$file"; then
    verdict=FAILED
  elif [ -n "$file" ] && grep -q 'REVIEW_PASSED' "$file"; then
    verdict=PASSED
  fi
  [ "$verdict" = PASSED ] || failed=1
  initial=$(printf '%s' "$lens" | cut -c1 | tr '[:lower:]' '[:upper:]')
  summary="${summary}${initial}:${verdict} "
done

result=PASSED
[ "$failed" -eq 0 ] || result=FAILED
gh pr comment "$pr_number" --body "🎯 review-swarm: ${result} (${summary% })"

