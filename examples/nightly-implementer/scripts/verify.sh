#!/usr/bin/env bash
# verify.sh — deterministic tsc + vitest gate.
#
# Emits {numPassed, numFailed, tscOk} on stdout. The parent step's
# json_schema verification requires numFailed === 0 AND tscOk === true.
# An agent cannot pass this by asserting success — the JSON is produced
# by the tools themselves.
#
# tsc runs first because a type error is cheaper to surface than a test
# failure and often produces the same defect. If tsc fails, vitest is
# skipped and both counts are reported as 0 alongside tscOk=false, so
# the parent verification sees "not-all-green" clearly.
set -euo pipefail

worktree="${1:?usage: verify.sh WORKTREE_PATH}"
cd "$worktree"

# Prefer the workspace's SDK dir if present; the design flow can be
# extended to accept a package path parameter later.
sdk="packages/sdk"
[ -d "$sdk" ] || sdk="."

# Capture tsc separately so a compile error is a distinct signal from
# a test failure. Both go to stderr for a human tail; the JSON is stdout.
if (cd "$sdk" && npx tsc --noEmit 2>&1 >&2); then
  tsc_ok=true
else
  tsc_ok=false
fi

if [ "$tsc_ok" = false ]; then
  jq -n '{numPassed: 0, numFailed: 0, tscOk: false}'
  exit 1
fi

# vitest --reporter=json includes numTotalTests / numFailedTests at the top.
# --outputFile is picked over stdout so tests using console.log don't
# corrupt the JSON payload.
report=$(mktemp)
trap 'rm -f "$report"' EXIT
(cd "$sdk" && npx vitest run --reporter=json --outputFile="$report" 2>&1 >&2) || true

num_passed=$(jq '.numPassedTests // 0' "$report")
num_failed=$(jq '.numFailedTests // 0' "$report")

jq -n \
  --argjson passed "$num_passed" \
  --argjson failed "$num_failed" \
  '{numPassed: $passed, numFailed: $failed, tscOk: true}'
[ "$num_failed" = 0 ] || exit 1
