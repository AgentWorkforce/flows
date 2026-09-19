#!/usr/bin/env bash
# Focused regression checks for the executable nightly-implementer gates.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/nightly-implementer-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_empty_blocker_reasons_fail_closed() {
  local output
  output=$(FLOWS_INPUT='{"correctness":{"blocked":true,"reasons":[]},"regression":{"blocked":false,"reasons":[]},"maintainability":{"blocked":false,"reasons":[]},"verify":{"numFailed":0}}' \
    "$root/scripts/aggregate-review.sh")
  jq -e '.approved == false and (.blockers | length == 1) and (.blockers[0] | contains("blocked with no reasons"))' \
    <<<"$output" >/dev/null || fail 'empty blocker reasons approved the aggregate'
}

test_diagnostics_do_not_corrupt_json() {
  local fixture="$tmp/verify-fixture"
  mkdir -p "$fixture/packages/sdk" "$tmp/bin"
  cat > "$tmp/bin/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  tsc)
    echo 'tsc diagnostic on stdout'
    ;;
  vitest)
    echo 'vitest diagnostic on stdout'
    for arg in "$@"; do
      case "$arg" in
        --outputFile=*) printf '{"numPassedTests":2,"numFailedTests":0}\n' > "${arg#--outputFile=}" ;;
      esac
    done
    ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$tmp/bin/npx"
  PATH="$tmp/bin:$PATH" "$root/scripts/verify.sh" "$fixture" > "$tmp/verify.json" 2> "$tmp/verify.stderr"
  jq -e '. == {numPassed: 2, numFailed: 0, tscOk: true}' "$tmp/verify.json" >/dev/null ||
    fail 'verify stdout was not its JSON payload'
  ! grep -q 'diagnostic on stdout' "$tmp/verify.json" ||
    fail 'tool diagnostics leaked onto verify stdout'
}

test_retry_worktrees_are_unique_and_non_destructive() {
  rg -F 'dir=$(mktemp -d "${TMPDIR:-/tmp}/relayflows-impl.XXXXXX")' "$root/nightly-implementer.flow.ts" >/dev/null ||
    fail 'worktree setup does not use an atomic unique directory'
  ! rg -F 'rm -rf "$dir"' "$root/nightly-implementer.flow.ts" >/dev/null ||
    fail 'worktree setup deletes an existing attempt directory'
}

test_needs_human_is_not_delivered() {
  local output
  output=$("$root/scripts/report-batch.sh" --outcomes '[{"issue":7,"repo":"AgentWorkforce/flows","outcome":"needs_human"}]')
  jq -e '.delivered == 0 and .needsHuman == 1 and .failed == 0' <<<"$output" >/dev/null ||
    fail 'needs_human was counted as delivered'
  rg -F 'if (isNeedsHuman(result))' "$root/nightly-batch.flow.ts" >/dev/null ||
    fail 'batch flow does not preserve needs_human outcomes'
}

test_blocked_url_uses_configured_repository() {
  local output status
  set +e
  output=$("$root/scripts/report-blocked.sh" --repo AgentWorkforce/cloud --issue 3534 --iterations 3 --blockers '[]')
  status=$?
  set -e
  [ "$status" -eq 3 ] || fail "report-blocked exited $status, expected 3"
  jq -e '.inspectionUrl == "https://github.com/AgentWorkforce/cloud/issues/3534"' <<<"$output" >/dev/null ||
    fail 'blocked URL did not use the configured repository'
  rg -F -- '--repo "$REPOSITORY"' "$root/nightly-implementer.flow.ts" >/dev/null ||
    fail 'flow does not pass the configured repository to report-blocked'
}

test_empty_blocker_reasons_fail_closed
test_diagnostics_do_not_corrupt_json
test_retry_worktrees_are_unique_and_non_destructive
test_needs_human_is_not_delivered
test_blocked_url_uses_configured_repository

echo 'nightly-implementer focused verification: PASS'
