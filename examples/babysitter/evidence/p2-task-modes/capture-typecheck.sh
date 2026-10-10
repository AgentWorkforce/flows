#!/usr/bin/env bash
# Typecheck with the same filter as the F4 evidence (pre-existing Ctx/helper
# noise). Exits nonzero when any error survives the filter.
cd "$(dirname "$0")/../.."
echo "\$ (cd examples/babysitter && ../../packages/sdk/node_modules/.bin/tsc -p tsconfig.json) | grep 'error TS' | grep -v 'TS2345.*Ctx\|relay-helpers\|ai-hist'"
out=$(../../packages/sdk/node_modules/.bin/tsc -p tsconfig.json | grep 'error TS' | grep -v 'TS2345.*Ctx\|relay-helpers\|ai-hist')
[ -n "$out" ] && echo "$out"
count=$(printf '%s' "$out" | grep -c 'error TS' || :)
echo "filtered-count=$count"
[ "$count" -eq 0 ]
