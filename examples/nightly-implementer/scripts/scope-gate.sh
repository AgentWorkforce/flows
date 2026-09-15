#!/usr/bin/env bash
# scope-gate.sh — deterministic scope-enforcement gate.
#
# Emits {scopeOk: true} on stdout when the implementation touched EXACTLY
# the declared files. Emits {scopeOk: false, touchedOutsideScope: [...]}
# and exits non-zero otherwise. The parent step's `json_schema`
# verification asserts scopeOk === true, so this script's exit code is a
# safety belt — the schema is what actually blocks the merge.
#
# This is the mechanical gate that would have caught the flows#242 case
# where an implementation "verified" while its work sat outside scope.
set -euo pipefail

worktree="${1:?usage: scope-gate.sh WORKTREE_PATH DECLARED_FILES_JSON}"
declared_json="${2:?usage: scope-gate.sh WORKTREE_PATH DECLARED_FILES_JSON}"

cd "$worktree"

# Merge-base diff — what THIS branch changed, not what main also has.
touched_sorted=$(git diff --name-only origin/main | sort -u)
declared_sorted=$(printf '%s' "$declared_json" | jq -r '.[]' | sort -u)

outside=$(comm -23 <(printf '%s\n' "$touched_sorted") <(printf '%s\n' "$declared_sorted"))
missing=$(comm -13 <(printf '%s\n' "$touched_sorted") <(printf '%s\n' "$declared_sorted"))

if [ -z "$outside" ] && [ -z "$missing" ]; then
  printf '{"scopeOk":true}\n'
  exit 0
fi

jq -n \
  --arg outside "$outside" \
  --arg missing "$missing" \
  '{scopeOk: false,
    touchedOutsideScope: ($outside | split("\n") | map(select(length > 0))),
    declaredButNotTouched: ($missing | split("\n") | map(select(length > 0)))}'
exit 1
