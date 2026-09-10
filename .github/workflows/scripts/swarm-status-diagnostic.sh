#!/usr/bin/env bash
set -euo pipefail

response=${1:-}

# Preferred shape: structured `.failure.{phase,code}`. Each field is
# token-validated so a candidate cannot inject shell/markdown that breaks
# the summary or a workflow command.
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
  exit 0
fi

# Legacy shape fallback. Every swarm-side taxonomy mode today
# (cursor_expired, workspace_busy, launch queue deadline, sandbox
# provisioning, database_overloaded, etc.) still emits `.result.error`
# rather than `.failure`. Dropping this path would silently lose all
# current diagnostics until the swarm side is migrated. Indent every line
# so a line starting with `::` cannot be parsed as an Actions workflow
# command and three backticks cannot close a fenced block early.
reason=$(jq -r '.result.error // .error // empty' <<<"$response" 2>/dev/null)
if [ -n "$reason" ]; then
  safe_reason=$(printf '%s\n' "$reason" | sed 's/^/    /')
  echo "swarm failure reason:" >&2
  printf '%s\n' "$safe_reason" >&2
  {
    echo "### Swarm failure reason"
    echo
    printf '%s\n' "$safe_reason"
  } >> "$GITHUB_STEP_SUMMARY"
fi
