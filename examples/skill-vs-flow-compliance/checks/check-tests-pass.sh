#!/bin/sh
# Final-state proxy for the skill's test-first rule: a test changed and the
# committed suite passes. This does not establish ordering or coverage.
set -eu
REPO="$1"
BASE_REF="${2:-baseline}"

cd "$REPO"

dirty=$(git status --porcelain --untracked-files=all)
if [ -n "$dirty" ]; then
  echo "FAIL working tree is not clean; commit the repair before review"
  exit 1
fi

changed_paths=$(git diff --name-only "$BASE_REF"...HEAD -- 'test/*.test.ts')
changed_tests=$(printf '%s\n' "$changed_paths" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$changed_tests" -eq 0 ]; then
  echo "FAIL no test file changed since $BASE_REF (test/*.test.ts)"
  exit 1
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT HUP INT TERM
if ! npm test --silent > "$log" 2>&1; then
  echo "FAIL npm test exited nonzero:"
  tail -n 20 "$log"
  exit 1
fi

echo "PASS $changed_tests test file(s) changed since $BASE_REF and npm test is green"
