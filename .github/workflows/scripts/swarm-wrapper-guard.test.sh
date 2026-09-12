#!/usr/bin/env bash
set -uo pipefail

# Transport-stub tests for the base-owned wrapper guard. In particular, a
# rename exposes the old path as `previous_filename`; testing only `filename`
# would leave the immutable wrapper movable.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
guard="$script_dir/swarm-wrapper-guard.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${GH_FIXTURE_MODE:-ok}" = fail ]; then
  echo 'transport failure' >&2
  exit 7
fi
jq -r '.[] | .filename, (.previous_filename // empty)' <<<"${GH_FIXTURE:?missing GH_FIXTURE}"
STUB
chmod +x "$work/bin/gh"

run_guard() {
  local fixture=$1 mode=${2:-ok}
  : > "$work/output"
  GH_FIXTURE="$fixture" GH_FIXTURE_MODE="$mode" \
    GITHUB_REPOSITORY=AgentWorkforce/flows PATH="$work/bin:$PATH" \
    GITHUB_OUTPUT="$work/output" \
    bash "$guard" 999 >"$work/out" 2>"$work/err"
}

failures=0
ok() { printf '  ok   %s\n' "$1"; }
notok() { printf '  FAIL %s\n     %s\n' "$1" "$2"; failures=$((failures + 1)); }
expect_reject() {
  local label=$1 fixture=$2
  if run_guard "$fixture"; then
    notok "$label" "unexpected success: $(cat "$work/out" "$work/err")"
  else
    ok "$label"
  fi
}

echo '== wrapper path coverage =='
protected_paths=(
  '.github/workflows/review-swarm.yml'
  '.github/workflows/review-swarm-wrapper-guard.yml'
  '.github/workflows/scripts/swarm-wrapper-guard.sh'
  '.github/workflows/scripts/swarm-gate.test.sh'
  '.github/workflows/scripts/swarm-definition.sh'
  '.github/workflows/scripts/swarm-definition.test.sh'
  '.github/workflows/scripts/swarm-status-diagnostic.sh'
  '.github/workflows/scripts/swarm-status-diagnostic.test.sh'
  '.github/workflows/scripts/swarm-prepare.sh'
  '.github/workflows/scripts/swarm-post.sh'
  '.github/workflows/scripts/swarm-verdict.sh'
  '.github/workflows/scripts/swarm-wrapper-guard.test.sh'
  '.github/workflows/scripts/review-swarm-workflow.test.sh'
)
for protected_path in "${protected_paths[@]}"; do
  expect_reject "direct protected path is rejected: $protected_path" \
    "[{\"status\":\"modified\",\"filename\":\"$protected_path\"}]"
  grep -Fqx 'guard_result=rejected' "$work/output" \
    && ok "rejection result is explicit: $protected_path" \
    || notok "rejection result is explicit: $protected_path" "$(cat "$work/output")"
done
expect_reject 'wrapper rename is rejected through previous_filename' \
  '[{"status":"renamed","filename":".github/workflows/review-swarm-renamed.yml","previous_filename":".github/workflows/review-swarm.yml"}]'
grep -Fqx 'guard_result=rejected' "$work/output" \
  && ok 'rename rejection result is explicit' \
  || notok 'rename rejection result is explicit' "$(cat "$work/output")"

if run_guard '[{"status":"modified","filename":"README.md"}]'; then
  grep -Fqx 'REVIEW_SWARM_WRAPPER_GUARD_OK' "$work/out" \
    && ok 'unrelated edit is allowed' \
    || notok 'unrelated edit is allowed' "$(cat "$work/out")"
  grep -Fqx 'guard_result=clean' "$work/output" \
    && ok 'clean result is explicit' \
    || notok 'clean result is explicit' "$(cat "$work/output")"
else
  notok 'unrelated edit is allowed' "$(cat "$work/out" "$work/err")"
fi

if run_guard '[{"status":"modified","filename":"workflows/review-swarm.yaml"}]'; then
  ok 'candidate review definition is validated by its trusted gate'
else
  notok 'candidate review definition is validated by its trusted gate' "$(cat "$work/out" "$work/err")"
fi

if run_guard '' fail; then
  notok 'GitHub API failures are not treated as a clean pass' 'unexpected success'
else
  ok 'GitHub API failures are propagated'
fi
grep -Fqx 'guard_result=error' "$work/output" \
  && ok 'infrastructure failure result is explicit' \
  || notok 'infrastructure failure result is explicit' "$(cat "$work/output")"

printf '\n%d failure(s)\n' "$failures"
[ "$failures" -eq 0 ]
