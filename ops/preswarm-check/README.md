# Pre-swarm-check

Run the 3-lens code review (maintainability / history / structure) on
the committed diff on this branch versus `main` **before** opening a PR, so
the post-push `review-swarm-loop.sh` does not have to spend ~4 minutes
per swarm cycle surfacing the same class of findings.

## Why

Every iteration of a PR that gets caught for a commit-message untruth
(count off, path wrong, "verbatim" not really verbatim), a rowid-vs-ULID
false claim, or a fail-open-called-fail-closed inversion burns:

- ~4 min of swarm wall-clock across three lens processes
- one iteration of author time to write the fix
- one force-push + marker-scramble + kickstart cycle

Running the identical lens prompts locally against the same diff catches
those before they hit main. The check IS a relayflow — three
deterministic steps invoking `sh ops/preswarm-check/lens-runner.sh
<lens>`, verified via the kernel's implicit `exit_code == 0` gate on deterministic steps (the runner exits 0 on REVIEW_PASSED, 1 on FAILED or NO_VERDICT). Same
kernel that runs `hn-monitor`, same PASSED/FAILED marker convention as
the post-push swarm.

## Use

From a repo checkout with your changes COMMITTED on a branch (staged-
but-uncommitted or unstaged changes are excluded — the check reviews
`git diff main..HEAD`, not the working tree):

```
flows run workflows/preswarm-check.yaml
```

Exit 0 means all three lenses PASSED — safe to push and open the PR.
Non-zero means at least one lens FAILED; the failing lens's full review
is in that step's stdout inside the run's journal
(`.relayflowd/runs/<ulid>.sqlite3`).

The three lenses are declared independent (`dependsOn: []`) so they
are all runnable when the flow starts, but the kernel's current
dispatch runs them SERIALLY (one step at a time), not concurrently.
Wall-clock is therefore roughly the sum of the three lens durations
(~10-15 min total, not ~4 min). Genuine parallel dispatch inside a
single flow run is a kernel follow-up.

## Environment

- `LENS_TIMEOUT` (seconds, default 900) — per-lens runner ceiling.
  **Note**: `workflows/preswarm-check.yaml` also sets `timeoutMs:
  930000` (930s) as a HARD step ceiling the kernel enforces. Setting
  `LENS_TIMEOUT` past ~900 has no effect unless the yaml's
  `timeoutMs` is bumped in step. The 30s gap between them is
  deliberate: the runner should always classify (emit `NO_VERDICT`)
  before the kernel step kills the process.
- `BASE_REF` (default `main`) — the ref to diff against. `git diff
  $BASE_REF..HEAD` is what the lens reviews.

## What the lenses check

Prompts of the same shape as `workflows/review-swarm.yaml`, adapted for
local pre-flight (the history-lens prompt here adds an explicit
"Scaffolding PRs PASS as long as they document deferrals" carve-out
the post-push swarm does not have). Rulebook drift between the two is
a known follow-up — consolidating both into one file both consumers
read is the right fix; that has not shipped yet.

- **maintainability** (`claude -p`): unclear boundaries, implicit
  contracts, missing failure handling, comments that assert what the
  code does not do, tests that would not fail if the behavior broke.
- **history** (`codex exec`): repeats a DRIVE-LOG-recorded mistake,
  introduces a new settled-RFC contradiction, or commit-message
  untruths about the diff.
- **structure** (`opencode run`): boundaries, coupling, file size,
  single-purpose; matches RFC-0001 (closed kernel vocabulary,
  helpers over primitives, fail-closed, `completionReason`
  discipline) and AGENTS.md.

## Known limitations

- **This is a LOCAL preflight, not a merge gate.** The actual merge
  gate is the post-push `review-swarm` running from `main`'s copy of
  the runner. Per RFC-0001 settled decision 6 ("gate definitions are
  owned outside the mutating agent's write scope"), a branch that
  modifies the runner or the flow spec is asking a potentially-
  tampered gate to judge itself. `lens-runner.sh` **REFUSES** (exit
  3) when it detects such a diff. Override — with the understanding
  that the local outcome is not authoritative — by setting
  `PRESWARM_ALLOW_SELF_JUDGE=1`. In either case the post-push swarm
  running from main is the real gate for a self-touching PR.
- **The lens steps are typed `deterministic` even though they invoke
  LLM CLIs.** RFC-0001 reserves `deterministic` for pure scripts.
  Migrating to `llm` steps would be the RFC-aligned shape, and the
  SDK's `LlmStepSpec` already ships `prompt` / `model` / `cli` with
  preflight CLI + auth-health probes. The blocker is not the SDK
  — it is that `llm` steps embed a STATIC prompt at spec-write time,
  and the pre-swarm-check needs to inject the CURRENT working diff
  into the prompt at run time. Until the SDK supports prompt
  templating (e.g. `{{diff_from(main)}}`), a `deterministic` step
  that shells out to a runner that builds the prompt with the live
  diff is the only shape available. Adding prompt templating to
  `llm` steps unblocks the migration and is the correct follow-up.
- Requires `claude`, `codex`, `opencode` CLIs on PATH. If any is
  missing the corresponding lens exits non-zero; the kernel's
  implicit `exit_code == 0` gate then fails that step.
- The lens prompts are duplicated from `workflows/review-swarm.yaml`.
  A rulebook drift between the two is a real risk; consolidating
  them into a shared file both consumers read is a follow-up.
- No dedicated CLI runner test — the runner's exit code is the sole
  correctness check. A shell harness that feeds canned outputs and
  asserts the emitted marker + exit code (in particular pinning that
  the classifier keys on the LAST anchored REVIEW_PASSED/FAILED line,
  not any nearby mention) is a cheap follow-up worth adding.
- Empty diff versus `$BASE_REF` currently PASSES with a stderr
  warning. Common footgun: wrong `BASE_REF` or forgotten commit
  produces a spurious green. Consider an explicit `--require-diff`
  flag as a follow-up.
