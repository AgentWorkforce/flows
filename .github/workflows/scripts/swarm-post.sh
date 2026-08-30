#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || ! $2 =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <run-id> <pr-number>" >&2
  exit 64
fi

run_id=$1
pr_number=$2

agent-relay cloud sync "$run_id"
run_logs=$(agent-relay cloud logs "$run_id")
aggregate_output=$(awk '
  /\[aggregate\] Output:/ { capture = 1; next }
  capture && /\[workflow [^]]*\] \[[^]]+\]/ { exit }
  capture { print }
' <<<"$run_logs")

declare -a labels=(maintainability history structure)
declare -a short_labels=(M H S)
declare -a marker_values=()

for index in "${!labels[@]}"; do
  lens=${labels[$index]}
  review=$(find ops/reviews -maxdepth 1 -type f \
    -name "*-pr${pr_number}-${lens}.md" -print | sort | tail -n 1)
  if [[ -z $review ]]; then
    echo "no $lens review found for PR #$pr_number" >&2
    exit 1
  fi

  verdict=$(grep -Eo 'REVIEW_(PASSED|FAILED)' "$review" | tail -n 1 || true)
  case "$verdict" in
    REVIEW_PASSED) marker_values+=("${short_labels[$index]}:PASSED") ;;
    REVIEW_FAILED) marker_values+=("${short_labels[$index]}:FAILED") ;;
    *)
      echo "$review has no review verdict" >&2
      exit 1
      ;;
  esac

  gh pr comment "$pr_number" --body-file "$review"
done

if grep -q 'SWARM_PASSED' <<<"$aggregate_output"; then
  aggregate=PASSED
elif grep -q 'SWARM_FAILED' <<<"$aggregate_output"; then
  aggregate=FAILED
else
  echo "run $run_id has no aggregate swarm verdict" >&2
  exit 1
fi

printf -v marker '🎯 review-swarm: %s (%s %s %s)' \
  "$aggregate" "${marker_values[0]}" "${marker_values[1]}" "${marker_values[2]}"
gh pr comment "$pr_number" --body "$marker"
