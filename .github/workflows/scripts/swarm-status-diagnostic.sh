#!/usr/bin/env bash
set -euo pipefail

response=${1:-}
summary_path=${GITHUB_STEP_SUMMARY:-}

# Diagnostics are observability only: a missing or malformed status response
# must never turn the wait step into a second, opaque failure. Keep the
# diagnostic path total and write a fixed, non-sensitive message when the
# response cannot be safely interpreted. The caller still enforces the swarm
# status separately.
append_summary() {
  local line=$1
  [ -n "$summary_path" ] || return 0
  if ! printf '%s\n' "$line" >>"$summary_path"; then
    echo "swarm diagnostic: could not write GITHUB_STEP_SUMMARY" >&2
  fi
}

unavailable() {
  local reason=$1
  echo "swarm failure diagnostic unavailable: $reason" >&2
  append_summary "- Swarm failure diagnostic unavailable: $reason"
}

if [ -z "$response" ]; then
  unavailable "empty status payload"
  exit 0
fi

# Parse once before extracting fields. Do not echo malformed input: status
# payloads may include provider errors or agent-controlled text. A fixed
# message is enough to distinguish this observability failure from a swarm
# verdict without creating a log or Markdown injection sink.
if ! normalized=$(jq -c . <<<"$response" 2>/dev/null); then
  unavailable "malformed status payload"
  exit 0
fi

# Preferred shape: structured `.failure.{phase,code}`. These fields are
# bounded identifier tokens, not arbitrary prose: the allowlist prevents
# shell/Actions-command and Markdown-fence injection when the value is copied
# to stderr and the step summary. Keep it aligned with the Cloud failure
# diagnostic contract; unknown fields are intentionally ignored.
if ! failure=$(jq -c '
  def token: if type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$") then . else null end;
  (if type == "object" then . else {} end) as $status
  | (if ($status | type) == "object" then ($status.failure // {}) else {} end) as $failure
  | if ($failure | type) == "object" then $failure else {} end
  | {phase: (.phase? // null | token), code: (.code? // null | token)}
  | with_entries(select(.value != null))
' <<<"$normalized" 2>/dev/null); then
  unavailable "status payload could not be inspected"
  exit 0
fi
if [ -n "$failure" ] && [ "$failure" != '{}' ]; then
  echo "swarm failure diagnostic: $failure" >&2
  append_summary "- Swarm failure diagnostic: \`$failure\`"
  exit 0
fi

# Legacy shape fallback. Every swarm-side taxonomy mode today
# (cursor_expired, workspace_busy, launch queue deadline, sandbox
# provisioning, database_overloaded, etc.) still emits `.result.error`
# rather than `.failure`. Dropping this path would silently lose all
# current diagnostics until the swarm side is migrated. Indent every line
# so a line starting with `::` cannot be parsed as an Actions workflow
# command and three backticks cannot close a fenced block early.
if ! reason=$(jq -r '
  if type == "object" then
    (.result.error // .error // empty) as $reason
    | if ($reason | type) == "string" then $reason else empty end
  else
    empty
  end
' <<<"$normalized" 2>/dev/null); then
  unavailable "status payload could not be inspected"
  exit 0
fi
if [ -n "$reason" ]; then
  safe_reason=$(printf '%s\n' "$reason" | sed 's/^/    /')
  echo "swarm failure reason:" >&2
  printf '%s\n' "$safe_reason" >&2
  append_summary "### Swarm failure reason"
  append_summary ""
  append_summary "$safe_reason"
else
  unavailable "no safe failure fields in status payload"
fi
