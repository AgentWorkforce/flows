#!/usr/bin/env bash
# Regression test for the review-swarm gate's verdict path.
#
# Why this exists: the gate is three lines of shell deciding whether code
# merges. The failure mode that matters is not "the gate is red" -- a red gate
# announces itself. It is a gate that has quietly become incapable of being
# red, which announces nothing and is discovered only after something broken
# ships behind it. So this suite asserts BOTH directions: a genuine objection
# must fail, and a genuine pass must pass. A suite that only checked the happy
# path would itself be the vacuous green it is meant to prevent.
#
# Hermetic: `agent-relay` and `gh` are stubbed on PATH, so this runs offline
# and exercises the real swarm-post.sh / swarm-verdict.sh, not a paraphrase.
set -uo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pass=0
fail=0

ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
notok(){ fail=$((fail+1)); printf '  FAIL %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; }

expect_eq() {
  local label=$1 want=$2 got=$3
  [ "$want" = "$got" ] && ok "$label" || notok "$label" "$want" "$got"
}

# ---------------------------------------------------------------------------
# Unit: verdict extraction from a transcript's final non-empty line.
# ---------------------------------------------------------------------------
# shellcheck source=swarm-verdict.sh
source "$script_dir/swarm-verdict.sh"

verdict_of() {
  local tmp; tmp=$(mktemp)
  printf '%s' "$1" > "$tmp"
  swarm_transcript_verdict "$tmp"
  rm -f "$tmp"
}

echo "== verdict extraction =="
expect_eq "a bare REVIEW_FAILED is FAILED" \
  FAILED "$(verdict_of 'Findings: P1 leak.
REVIEW_FAILED')"

expect_eq "a bare REVIEW_PASSED is PASSED" \
  PASSED "$(verdict_of 'Looks good.
REVIEW_PASSED')"

expect_eq "trailing blank lines do not hide the marker" \
  FAILED "$(verdict_of 'REVIEW_FAILED

')"

expect_eq "surrounding whitespace is trimmed" \
  PASSED "$(verdict_of '   REVIEW_PASSED   ')"

# This is the bug PR #248 addresses, observed live on PR #240: a complete
# review whose marker is followed by a sign-off line is discarded as UNCLEAR.
expect_eq "a marker followed by a sign-off is UNCLEAR (PR #240 bug)" \
  UNCLEAR "$(verdict_of 'REVIEW_PASSED

**Review completed:** 2026-09-09 08:45')"

# The safety property that must survive the #248 prompt change. If a lens
# genuinely objects, no amount of prompt wording may turn that into a pass.
expect_eq "REVIEW_FAILED is never upgraded by surrounding prose" \
  UNCLEAR "$(verdict_of 'REVIEW_FAILED
structure-only review.')"

expect_eq "an empty transcript is UNCLEAR, not PASSED" \
  UNCLEAR "$(verdict_of '')"

expect_eq "a transcript merely containing the word is UNCLEAR" \
  UNCLEAR "$(verdict_of 'I considered emitting REVIEW_PASSED but did not.')"

# ---------------------------------------------------------------------------
# Unit: lens selection -- missing and stale transcripts must be fail-closed.
# ---------------------------------------------------------------------------
echo "== lens selection =="
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
mkdir -p "$work/ops/reviews"

expect_eq "no reviews directory yields MISSING" \
  "MISSING	" "$(swarm_lens_result "$work/nope" 246 structure "")"

expect_eq "an absent transcript yields MISSING" \
  "MISSING	" "$(swarm_lens_result "$work/ops/reviews" 246 structure "")"

marker="$work/marker"; touch "$marker"
sleep 1
old="$work/ops/reviews/20260101-0000-pr246-structure.md"
printf 'REVIEW_PASSED\n' > "$old"
touch -t 202601010000 "$old"          # older than the marker
expect_eq "a transcript predating the run yields STALE" \
  STALE "$(swarm_lens_result "$work/ops/reviews" 246 structure "$marker" | cut -f1)"

fresh="$work/ops/reviews/20260909-1200-pr246-structure.md"
printf 'REVIEW_PASSED\n' > "$fresh"
expect_eq "the newest fresh transcript wins" \
  PASSED "$(swarm_lens_result "$work/ops/reviews" 246 structure "$marker" | cut -f1)"

# ---------------------------------------------------------------------------
# End-to-end: the real swarm-post.sh, with agent-relay and gh stubbed.
# ---------------------------------------------------------------------------
echo "== swarm-post.sh end to end =="

# $1 = sync behaviour: 'writes:<lens>=<verdict>,...' or 'nochanges'
run_post() {
  local spec=$1 sandbox bin
  sandbox=$(mktemp -d)
  bin="$sandbox/bin"; mkdir -p "$bin" "$sandbox/repo"

  cat > "$bin/agent-relay" <<STUB
#!/usr/bin/env bash
# Stubs \`agent-relay cloud sync\`. Real CLI exits 1 and prints
# "No changes to sync" when the workflow modified nothing -- the shape seen on
# runs 34274491229 (#247) and 34331239850 (#248).
if [ "\$1" = cloud ] && [ "\$2" = sync ]; then
  if [ "$spec" = nochanges ]; then
    echo "No changes to sync — the workflow did not modify any files."
    exit 1
  fi
  mkdir -p ops/reviews
  for pair in \$(echo "${spec#writes:}" | tr ',' ' '); do
    lens=\${pair%%=*}; v=\${pair##*=}
    printf 'Full review body.\n%s\n' "\$v" \
      > "ops/reviews/20260909-1200-pr999-\$lens.md"
  done
  echo "Synced."
fi
exit 0
STUB

  # gh must never reach the network from a test. Record calls instead.
  cat > "$bin/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "gh \$*" >> "$sandbox/gh-calls.log"
exit 0
STUB
  chmod +x "$bin/agent-relay" "$bin/gh"

  ( cd "$sandbox/repo" && PATH="$bin:$PATH" \
      bash "$script_dir/swarm-post.sh" test-run-id 999 >"$sandbox/out" 2>&1 )
  local rc=$?
  post_out=$(cat "$sandbox/out")
  post_log=$(cat "$sandbox/gh-calls.log" 2>/dev/null || true)
  rm -rf "$sandbox"
  return $rc
}

# Did the run report its verdict to the PR at all? A gate that fails silently
# is only half a gate: the check is red but nothing says which lens objected.
posted_a_rollup() { case "$post_log" in *"pr comment"*) return 0 ;; *) return 1 ;; esac; }

# THE load-bearing assertion. A genuine objection from one lens must fail the
# gate even when the other two pass.
run_post 'writes:maintainability=REVIEW_PASSED,history=REVIEW_PASSED,structure=REVIEW_FAILED'
expect_eq "one lens REVIEW_FAILED fails the gate (exit 1)" 1 "$?"
posted_a_rollup \
  && ok "a failing run still reports its verdict to the PR" \
  || notok "a failing run still reports its verdict to the PR" "a gh comment" "none"

# The counterweight: a gate that cannot pass is as broken as one that cannot
# fail. Without this, every assertion above is satisfiable by \`exit 1\`.
run_post 'writes:maintainability=REVIEW_PASSED,history=REVIEW_PASSED,structure=REVIEW_PASSED'
expect_eq "three clean passes pass the gate (exit 0)" 0 "$?"

run_post 'writes:maintainability=REVIEW_PASSED,history=REVIEW_PASSED,structure=UNCLEAR_JUNK'
expect_eq "an UNCLEAR lens fails the gate" 1 "$?"

run_post 'writes:maintainability=REVIEW_PASSED,history=REVIEW_PASSED'
expect_eq "a lens with no transcript at all fails the gate" 1 "$?"

# The #246/#247/#248 production shape: swarm died, nothing synced.
run_post nochanges
rc=$?
[ "$rc" -ne 0 ] && ok "an empty sync fails the gate (exit $rc)" \
  || notok "an empty sync fails the gate" "non-zero" "$rc"

case "$post_out" in
  *"No changes to sync"*) ok "the empty-sync reason reaches the step log" ;;
  *) notok "the empty-sync reason reaches the step log" "the CLI message" "$post_out" ;;
esac

# Documents a real limitation rather than asserting it is good. `set -e` kills
# swarm-post.sh at `agent-relay cloud sync`, so when the swarm dies the PR gets
# no comment from this run and the previous run's rollup stays visible. The
# gate is still red -- `Enforce swarm result` is a separate step keyed on
# swarm_status -- but a reader looking only at PR comments sees a stale verdict.
posted_a_rollup \
  && notok "KNOWN: an empty sync posts no comment" "no comment" "a comment" \
  || ok "KNOWN: an empty sync posts no comment; the red check is the only signal"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
