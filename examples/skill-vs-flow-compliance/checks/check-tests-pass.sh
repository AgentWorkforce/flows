#!/bin/sh
# Rule 1 (test-first) as a deterministic check: it cannot verify ORDERING
# (that would need per-commit inspection the agent's commit history doesn't
# reliably provide), but it can verify the two things that ordering exists
# to guarantee: a test changed, and the suite is green. A change that edits
# only src/ with no test touched fails this before `npm test` even runs.
set -eu
REPO="$1"
BASE_REF="${2:-baseline}"

cd "$REPO"

changed_tests=$(git diff --name-only "$BASE_REF"...HEAD -- 'test/*.test.ts' | wc -l | tr -d ' ')
if [ "$changed_tests" -eq 0 ]; then
  echo "FAIL no test file changed since $BASE_REF (test/*.test.ts)"
  exit 1
fi

if ! npm test --silent > /tmp/check-tests-pass.$$.log 2>&1; then
  echo "FAIL npm test exited nonzero:"
  tail -n 20 /tmp/check-tests-pass.$$.log
  rm -f /tmp/check-tests-pass.$$.log
  exit 1
fi
rm -f /tmp/check-tests-pass.$$.log

echo "PASS $changed_tests test file(s) changed since $BASE_REF and npm test is green"
