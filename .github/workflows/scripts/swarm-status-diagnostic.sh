#!/usr/bin/env bash
set -euo pipefail

response=${1:-}
reason=$(jq -r '.result.error // .error // empty' <<<"$response" 2>/dev/null)
if [ -n "$reason" ]; then
  safe_reason=$(printf '%s\n' "$reason" | sed 's/^/    /')
  echo "swarm failure reason:" >&2
  printf '%s\n' "$safe_reason" >&2
  { echo "### Swarm failure reason"; echo; printf '%s\n' "$safe_reason"; } >> "$GITHUB_STEP_SUMMARY"
fi
