#!/usr/bin/env bash
set -euo pipefail

response=${1:-}
failure=$(jq -c '
  def token: if type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$") then . else null end;
  (if type == "object" then . else {} end) as $status
  | ($status.failure // {}) as $failure
  | if ($failure | type) == "object" then $failure else {} end
  | {phase: (.phase? // null | token), code: (.code? // null | token)}
  | with_entries(select(.value != null))
' <<<"$response" 2>/dev/null)
if [ -n "$failure" ] && [ "$failure" != '{}' ]; then
  echo "swarm failure diagnostic: $failure" >&2
  echo "- Swarm failure diagnostic: \`$failure\`" >> "$GITHUB_STEP_SUMMARY"
fi
