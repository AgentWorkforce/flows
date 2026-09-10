#!/bin/sh
# Rule 2 (no debug leftovers) as a deterministic check: grep only ADDED lines
# (git diff's `+` side) so pre-existing code the agent didn't touch can never
# fail this, and so a debug statement the agent added and then removed again
# in a later line never shows up (added lines only, not full-file content).
set -eu
REPO="$1"
BASE_REF="${2:-baseline}"

cd "$REPO"

diff=$(git diff "$BASE_REF"...HEAD -- '*.ts')
added_lines=$(printf '%s\n' "$diff" | sed -n '/^+++ /d; /^+/p')

hit=$(printf '%s\n' "$added_lines" | grep -E 'console\.(log|debug)\(|debugger;?|^\+[[:space:]]*//.*[A-Za-z].*\(.*\);?[[:space:]]*$' || true)

if [ -n "$hit" ]; then
  echo "FAIL debug leftover(s) in added lines:"
  echo "$hit" | head -n 10
  exit 1
fi

echo "PASS no console.log/console.debug/debugger/commented-out code in added lines"
