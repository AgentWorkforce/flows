#!/bin/sh
# Pre-swarm-check lens runner. Called from `workflows/preswarm-check.yaml`
# as a deterministic step for each of the three lenses (maintainability,
# history, structure). The prompts are the same shape the post-push
# review-swarm applies (see workflows/review-swarm.yaml). This file
# duplicates them today; consolidating them into one file both consumers
# read is called out in README as a known drift risk, not solved here.
#
# Usage: sh ops/preswarm-check/lens-runner.sh <lens-name>
#
# Reads the committed branch diff (`git diff $BASE_REF..HEAD`, NOT
# the working tree) and hands it to the
# lens CLI (`claude` / `codex` / `opencode`) — via stdin so the prompt
# is not bounded by ARG_MAX (~256KB on macOS). The lens is instructed
# to END its output with EXACTLY ONE of:
#   REVIEW_PASSED   — no blockers
#   REVIEW_FAILED   — at least one blocker
#
# Exit code IS the authority the flow spec keys on. Exits 0 when the
# CLI emitted REVIEW_PASSED; exits 1 on REVIEW_FAILED, on NO_VERDICT
# (CLI produced neither token), or on any CLI error. The kernel's
# implicit `exit_code == 0` gate for deterministic steps then fails
# the pre-swarm-check step. No `output_contains` gate is layered on
# top (that would be fail-open — the lens can quote arbitrary strings
# from the diff, including PASSED markers, so a substring match could
# not be trusted).
#
# The whole point of the pre-swarm-check: catch the swarm's classic
# findings (commit-message-vs-diff drift, count mismatches, missing
# FAIL-first mutations, evidence overreach) BEFORE the post-push swarm
# spends ~4 minutes surfacing them and burning a merge cycle. Every
# iteration this catches locally is one iteration the post-push loop
# does not have to run.

# NOTE: `set -e` deliberately omitted. The CLI invocations below
# (`timeout ... claude/codex/opencode`) can exit non-zero for reasons
# the runner must SEE and turn into a NO_VERDICT / REVIEW_FAILED
# outcome (auth expired, rate limit, timeout = 124). With `set -e`
# the script would exit before reaching the classifier and the
# `PRESWARM_<lens>: ...` gate would fire on empty stderr, hiding the
# real failure mode.
set -u

LENS=${1:-}
if [ -z "$LENS" ]; then
  echo "lens-runner: missing lens name (maintainability|history|structure)" >&2
  exit 2
fi

# Longer timeout than the swarm's default because a local run does not
# compete for CLI capacity the way the swarm does mid-day. Still bounded
# so a hung CLI never wedges the pre-check.
LENS_TIMEOUT=${LENS_TIMEOUT:-900}
BASE_REF=${BASE_REF:-main}

# `timeout` on macOS is not in the base install; coreutils installs
# `gtimeout`. Fall back cleanly so a stock Mac still runs this check.
# If neither is present we run without a wall-clock cap — noisier than
# ideal, but the alternative (refuse to run) is worse for a preflight.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout $LENS_TIMEOUT"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout $LENS_TIMEOUT"
else
  echo "lens-runner: neither timeout nor gtimeout on PATH; running lens uncapped" >&2
  TIMEOUT_CMD=""
fi

DIFF_FILE=$(mktemp -t preswarm-diff.XXXXXX)
GIT_DIFF_STDERR=$(mktemp -t preswarm-diff-err.XXXXXX)
trap 'rm -f "$DIFF_FILE" "$GIT_DIFF_STDERR"' EXIT
if ! git diff "$BASE_REF"..HEAD > "$DIFF_FILE" 2> "$GIT_DIFF_STDERR"; then
  echo "lens-runner: git diff $BASE_REF..HEAD failed; is $BASE_REF fetched?" >&2
  cat "$GIT_DIFF_STDERR" >&2
  exit 2
fi
if [ -s "$GIT_DIFF_STDERR" ]; then
  # Warnings from git-diff should not silently contaminate the diff
  # the lens sees; surface them on stderr so the caller notices.
  echo "lens-runner: git diff emitted stderr (surfaced, not embedded):" >&2
  cat "$GIT_DIFF_STDERR" >&2
fi
# Self-judging-gate refusal. RFC-0001 settled decision 6: "Gate
# definitions are owned outside the mutating agent's write scope."
# A branch that modifies THIS runner or the flow spec that invokes
# it is asking a potentially-tampered gate to judge itself. Refuse
# by default; a developer who explicitly acknowledges the reduced
# integrity can override with PRESWARM_ALLOW_SELF_JUDGE=1. The
# actual merge gate remains the post-push review-swarm which runs
# from `main`'s copy of the runner — that IS the authoritative
# check for a diff that touches this tree.
if grep -qE '^diff --git a/(ops/preswarm-check/|workflows/preswarm-check\.yaml)' "$DIFF_FILE"; then
  if [ "${PRESWARM_ALLOW_SELF_JUDGE:-0}" = "1" ]; then
    echo "lens-runner: WARNING — self-judgment: this diff modifies the pre-swarm-check itself. PRESWARM_ALLOW_SELF_JUDGE=1 override in effect. The post-push review-swarm from main is the authoritative check." >&2
  else
    echo "lens-runner: REFUSING to run — this diff modifies the pre-swarm-check itself (ops/preswarm-check/** or workflows/preswarm-check.yaml)." >&2
    echo "lens-runner:           A branch-owned gate cannot judge its own modifications (RFC-0001 settled decision 6)." >&2
    echo "lens-runner:           Set PRESWARM_ALLOW_SELF_JUDGE=1 to override with the understanding that the post-push review-swarm — running from main's copy — is the authoritative gate for this PR." >&2
    exit 3
  fi
fi
if [ ! -s "$DIFF_FILE" ]; then
  # Empty diff is a truthful pass — there is nothing that could break.
  # Common footgun: wrong BASE_REF or forgotten commit. Emit a WARNING
  # to stderr so a caller notices, keep the marker shape identical to
  # the non-empty path for legibility, and exit 0 so the kernel's
  # implicit exit_code gate treats it as PASSED.
  echo "lens-runner: WARNING — empty diff versus $BASE_REF. If you expected changes, check BASE_REF or that you committed." >&2
  echo "PRESWARM_${LENS}: REVIEW_PASSED"
  exit 0
fi

case "$LENS" in
  maintainability)
    LENS_PROMPT='You are the MAINTAINABILITY lens on a code-review swarm.
Ask: could a stranger read this diff in six months and change it safely?
Name unclear boundaries, implicit contracts, missing failure handling, comments
that assert what the code does not do, and tests that would not fail if the
behavior broke.'
    CLI=claude
    ;;
  history)
    LENS_PROMPT='You are the HISTORY lens on a code-review swarm.
Run `git log --oneline -40` and read ops/DRIVE-LOG.md, ops/NEXT.md, and
ops/DIRECTIVES.md if present. Reject the diff ONLY on these three:

  1. REPEATS a mistake DRIVE-LOG records — reintroduces a pattern a previous
     commit deliberately removed.
  2. INTRODUCES a NEW contradiction with a settled RFC-0001 decision — the
     diff adds a pattern the RFC explicitly rules out.
  3. The commit message TELLS UNTRUTHS about the diff — false claims about
     tests, evidence, scope, or files touched.

Scaffolding PRs (explicitly scoped, with deferrals documented in the commit
message or PR body) PASS this lens as long as they do not REGRESS
previously-fixed behavior and do not LIE.

Do NOT reject on:
  - Aspirational RFC decisions the diff does not yet fully realize.
  - Pre-existing scaffolding the diff does not touch.
  - Deferrals that name a follow-up (bundle digests, async drain
    semantics, etc) instead of implementing them all at once.
  - A drive-loop-generated file (like ops/NEXT.md) still referencing an
    older gate — that is a follow-up brief-and-tick concern, not a
    correctness violation of the diff being reviewed.

Note those as concerns, not blockers. A scaffolding-first PR that lands
cleanly is more valuable than a monolithic first PR that lands never.'
    CLI=codex
    ;;
  structure)
    LENS_PROMPT='You are the STRUCTURE lens on a code-review swarm.
Ask: boundaries, coupling, file size and single purpose. Does the shape match
RFC-0001 (closed kernel vocabulary, helpers over primitives, fail-closed,
completionReason discipline) and AGENTS.md? Name anything that puts product
logic in the kernel, adds a primitive instead of a helper, or grows a file past
its purpose.'
    CLI=opencode
    ;;
  *)
    echo "lens-runner: unknown lens '$LENS' (expected maintainability|history|structure)" >&2
    exit 2
    ;;
esac

# Read AGENTS.md and the RFC before reviewing so the lens has the same
# rulebook the post-push swarm does. `flow_key`, `spec_hash`, and other
# per-run context aren't relevant here — the lens is stateless.
FULL_PROMPT=$(cat <<PROMPT
$LENS_PROMPT

The repository is checked out at your current working directory. Read AGENTS.md,
docs/RFC-0001-everything-is-a-relayflow.md, and any charter file mentioned in
your lens brief before reviewing.

The diff under review (git diff $BASE_REF..HEAD, i.e. the COMMITTED diff on this branch):

\`\`\`diff
$(cat "$DIFF_FILE")
\`\`\`

Produce a concise review (200-500 words). Cite specific files and line ranges
from the diff. Name blockers vs concerns vs notes.

Structure the review with a section headed EXACTLY:

  ### Blockers

If there are no blockers, the first word under that heading must be `None`.

Your final token is DERIVED from that section — it is not a separate judgement:
  - `### Blockers` says None            -> you MUST end with REVIEW_PASSED
  - `### Blockers` lists one or more    -> you MUST end with REVIEW_FAILED

A token that disagrees with your own Blockers section is a defect in the review,
not a stricter verdict. Concerns and notes are NOT blockers and must not change
the token.

END your output with EXACTLY ONE of these tokens on its own line:
  REVIEW_PASSED   — no blockers
  REVIEW_FAILED   — at least one blocker
PROMPT
)

# CLI invocations run through $TIMEOUT_CMD (may be empty). We CAPTURE
# stdout+stderr and the exit code separately — a non-zero exit is a
# valid outcome (rate-limit, auth, timeout=124) that the classifier
# below turns into NO_VERDICT rather than a silent script abort.
# Feed the prompt via stdin instead of argv so a large diff (kernel
# refactor, tree move) does not blow past ARG_MAX (~256KB on macOS).
# All three CLIs accept the prompt on stdin when the arg is `-` or
# absent. `--dangerously-skip-permissions` on claude bypasses the
# interactive tool-confirm prompt — this script is a pre-flight and
# must be non-interactive; the equivalent flags on codex/opencode are
# their default (no interactive prompt to bypass).
CLI_RC=0
case "$CLI" in
  claude)
    OUTPUT=$(printf '%s\n' "$FULL_PROMPT" | $TIMEOUT_CMD claude -p --dangerously-skip-permissions 2>&1) || CLI_RC=$?
    ;;
  codex)
    OUTPUT=$(printf '%s\n' "$FULL_PROMPT" | $TIMEOUT_CMD codex exec - 2>&1) || CLI_RC=$?
    ;;
  opencode)
    OUTPUT=$(printf '%s\n' "$FULL_PROMPT" | $TIMEOUT_CMD opencode run 2>&1) || CLI_RC=$?
    ;;
  *)
    # `$CLI` is only set from the LENS case above, so this is
    # currently unreachable — but under `set -u` an unset `OUTPUT`
    # below would explode with a cryptic error. Fail cleanly.
    echo "lens-runner: internal error: unknown CLI '$CLI' for lens '$LENS'" >&2
    exit 2
    ;;
esac

# Emit the full lens output so a caller can read the review verbatim,
# then a final PASSED/FAILED line for the verification gate.
printf '%s\n' "$OUTPUT"

# Classification uses ONLY the LAST anchored verdict line — never
# "any FAILED anywhere in the tail". A review that quotes an earlier
# rejection ("prior reviews said REVIEW_FAILED for reason X") must
# still resolve to whatever verdict the reviewer commits to at the
# end. The two-step pipeline below extracts every line that is
# EXACTLY REVIEW_PASSED or EXACTLY REVIEW_FAILED (anchored by ^ and
# $), then keeps only the LAST one:
#
#   LAST_VERDICT=$(grep -E '^REVIEW_(PASSED|FAILED)$' | tail -1)
#
# Fail-closed dispatch:
#   - LAST_VERDICT == "REVIEW_FAILED"                  → exit 1 (FAILED)
#   - LAST_VERDICT == "REVIEW_PASSED" AND CLI_RC == 0  → exit 0 (PASSED)
#   - LAST_VERDICT == "REVIEW_PASSED" AND CLI_RC != 0  → exit 1 (NO_VERDICT — a CLI that emitted PASSED then errored is untrustworthy)
#   - LAST_VERDICT missing (no anchored line at all)   → exit 1 (NO_VERDICT)
LAST_VERDICT=$(printf '%s\n' "$OUTPUT" | grep -E '^REVIEW_(PASSED|FAILED)$' | tail -1)

# Does the review's own Blockers section say there are none? Read the first
# non-blank line under the LAST `### Blockers` heading. This NEVER upgrades a
# verdict — it only relabels REVIEW_FAILED as CONTRADICTION, and the exit code
# stays 1. Turning a failure into a pass on a substring would be exactly the
# fail-open the classifier above refuses.
# True when the LAST `### Blockers` section exists AND its first non-blank line
# is something other than "None". Deliberately NOT the negation of
# blockers_say_none: an ABSENT section returns false here, so a review that
# omits the section keeps its previous behaviour instead of newly failing. This
# closes the unambiguous fail-open without changing the blast radius for
# reviews that never emitted the section at all.
blockers_are_listed() {
  first="$(printf '%s\n' "$OUTPUT" \
    | awk '/^#+[[:space:]]*Blockers[[:space:]]*$/{f=1;next} f&&NF{print;exit}')"
  [ -n "$first" ] || return 1
  printf '%s' "$first" | grep -qiE '^\**None\b' && return 1
  return 0
}

blockers_say_none() {
  printf '%s\n' "$OUTPUT" \
    | awk '/^#+[[:space:]]*Blockers[[:space:]]*$/{f=1;next} f&&NF{print;exit}' \
    | grep -qiE '^\**None\b'
}

case "$LAST_VERDICT" in
  REVIEW_FAILED)
    if blockers_say_none; then
      # The lens found nothing blocking and still emitted REVIEW_FAILED. That is
      # a broken review, not a stricter one, and a caller cannot appeal it: the
      # exit code is authoritative by design. Say so plainly so the branch is not
      # blamed for a gate defect. See flows#218.
      echo "PRESWARM_${LENS}: CONTRADICTION — review says 'Blockers: None' but emitted REVIEW_FAILED; treating as NO_VERDICT (gate defect, not a finding)" >&2
      exit 1
    fi
    echo "PRESWARM_${LENS}: REVIEW_FAILED"
    exit 1
    ;;
  REVIEW_PASSED)
    if [ "$CLI_RC" -eq 0 ]; then
      if blockers_are_listed; then
        # A review that enumerates blockers and still emits REVIEW_PASSED is the
        # same defect as the REVIEW_FAILED arm above, in the direction that
        # actually matters. That arm relabels a contradiction which already
        # fails CLOSED; this one would have let a review naming unauthorized
        # writes exit 0.
        #
        # The comment above claims this classifier "NEVER upgrades a verdict",
        # and it does not. That was the wrong safety property to reason about:
        # one-directional safety left the fail-OPEN direction unguarded, which
        # is the only direction a gate cannot afford to get wrong. Found by an
        # independent spec review, not by the author.
        echo "PRESWARM_${LENS}: CONTRADICTION — review listed blockers but emitted REVIEW_PASSED; treating as NO_VERDICT (gate defect, not a pass)" >&2
        exit 1
      fi
      echo "PRESWARM_${LENS}: REVIEW_PASSED"
      exit 0
    fi
    echo "PRESWARM_${LENS}: NO_VERDICT — final token was REVIEW_PASSED but CLI exit=${CLI_RC} (untrustworthy)" >&2
    exit 1
    ;;
  *)
    echo "PRESWARM_${LENS}: NO_VERDICT — no anchored REVIEW_PASSED or REVIEW_FAILED line in the CLI output (CLI exit=${CLI_RC})" >&2
    exit 1
    ;;
esac
