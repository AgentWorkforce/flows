#!/usr/bin/env bash
set -uo pipefail

# Deterministic contract tests for the base-owned diagnostic helper. The
# helper reports observability failures as fixed text and always exits zero;
# `review-swarm.yml` owns pass/fail through swarm_status.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
diagnostic="$script_dir/swarm-status-diagnostic.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
ok() { printf '  ok   %s\n' "$1"; }
notok() { printf '  FAIL %s\n     %s\n' "$1" "$2"; failures=$((failures + 1)); }

run_case() {
  local name=$1 payload=$2 summary_mode=${3:-summary}
  local summary="$work/$name.summary" out="$work/$name.out" err="$work/$name.err"
  local rc
  : > "$summary"
  if [ "$summary_mode" = none ]; then
    env -u GITHUB_STEP_SUMMARY bash "$diagnostic" "$payload" >"$out" 2>"$err"
    rc=$?
  else
    GITHUB_STEP_SUMMARY="$summary" bash "$diagnostic" "$payload" >"$out" 2>"$err"
    rc=$?
  fi
  printf '%s\n' "$rc|$out|$err|$summary"
}

assert_success() {
  local label=$1 rc=$2
  [ "$rc" -eq 0 ] && ok "$label exits zero" \
    || notok "$label exits zero" "exit status: $rc"
}

echo '== structured diagnostics =='
paths=$(run_case structured '{"failure":{"phase":"queue","code":"queue_timeout"}}')
IFS='|' read -r rc out err summary <<< "$paths"
assert_success structured "$rc"
grep -Fqx 'swarm failure diagnostic: {"phase":"queue","code":"queue_timeout"}' "$err" \
  && ok 'structured phase/code fields are emitted' \
  || notok 'structured phase/code fields are emitted' "$(cat "$err")"
grep -Fqx -- '- Swarm failure diagnostic: `{"phase":"queue","code":"queue_timeout"}`' "$summary" \
  && ok 'structured diagnostic reaches the summary' \
  || notok 'structured diagnostic reaches the summary' "$(cat "$summary")"

echo '== safe malformed and unsupported payloads =='
paths=$(run_case malformed '{')
IFS='|' read -r rc out err summary <<< "$paths"
assert_success malformed "$rc"
grep -Fqx 'swarm failure diagnostic unavailable: malformed status payload' "$err" \
  && ok 'malformed JSON has a fixed diagnostic' \
  || notok 'malformed JSON has a fixed diagnostic' "$(cat "$err")"
[ ! -s "$out" ] && ok 'malformed JSON has no stdout' || notok 'malformed JSON has no stdout' "$(cat "$out")"

paths=$(run_case empty '' none)
IFS='|' read -r rc out err summary <<< "$paths"
assert_success empty "$rc"
grep -Fqx 'swarm failure diagnostic unavailable: empty status payload' "$err" \
  && ok 'empty payload is safe without GITHUB_STEP_SUMMARY' \
  || notok 'empty payload is safe without GITHUB_STEP_SUMMARY' "$(cat "$err")"

paths=$(run_case unsupported '[]')
IFS='|' read -r rc out err summary <<< "$paths"
assert_success unsupported "$rc"
grep -Fqx 'swarm failure diagnostic unavailable: no safe failure fields in status payload' "$err" \
  && ok 'valid unsupported JSON is explicit' \
  || notok 'valid unsupported JSON is explicit' "$(cat "$err")"

echo '== legacy compatibility and injection boundary =='
paths=$(run_case legacy '{"result":{"error":"quota exceeded"}}')
IFS='|' read -r rc out err summary <<< "$paths"
assert_success legacy "$rc"
grep -Fqx 'swarm failure reason:' "$err" \
  && grep -Fqx '    quota exceeded' "$err" \
  && ok 'legacy error text remains available' \
  || notok 'legacy error text remains available' "$(cat "$err")"

paths=$(run_case invalid-token '{"failure":{"phase":"::error:: injected","code":"```"}}')
IFS='|' read -r rc out err summary <<< "$paths"
assert_success invalid-token "$rc"
if grep -q '^::\|^```' "$err" "$summary"; then
  notok 'invalid tokens never reach command or fence positions' "$(cat "$err"; cat "$summary")"
else
  ok 'invalid tokens never reach command or fence positions'
fi

paths=$(run_case top-level-error '{"error":"quota exceeded"}')
IFS='|' read -r rc out err summary <<< "$paths"
assert_success top-level-error "$rc"
expected=$'### Swarm failure reason\n\n    quota exceeded'
if [ "$(cat "$summary")" = "$expected" ] \
  && grep -Fqx 'swarm failure reason:' "$err" \
  && grep -Fqx '    quota exceeded' "$err"; then
  ok 'top-level legacy error reaches logs and summary safely'
else
  notok 'top-level legacy error reaches logs and summary safely' "$(cat "$err" "$summary")"
fi

printf '\n%d failure(s)\n' "$failures"
[ "$failures" -eq 0 ]
