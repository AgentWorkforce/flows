# Backlog — durable, below directives

Items the Lead should weigh in assess after ops/DIRECTIVES.md and the current
gate's needs. Not commitments; ordering is the Lead's call with evidence.

- **Close the deterministic-command preflight gap (Codex P1).** Refuse a
  path-like deterministic command word (contains `/`) when that path does not
  exist, while retaining the warning for bare words that may be shell builtins,
  functions, or assignments. Filed from PR #8; deliberately not implemented
  in WP-4-FIX.
- **Release pipeline (relay pattern, NOT crates.io):** cross-compile
  `relayflowd` per platform in CI, bundle binaries into the npm `flows`
  CLI/SDK + curl installer for self-host cells (see `../relay`
  `.github/workflows/publish.yml` — binary matrix shipped inside the npm
  package; no `cargo publish`). Reserve crate names on crates.io as a
  squatting hedge only. Needed before gate 2/3 consumers run on the kernel.
- **Persist review transcripts:** the review step's verdict currently leaves
  no evidence artifact (only the gating token). Capture review output to
  ops/ per tick until the kernel journal owns it.
- **Re-register cloud schedules from current drive.yaml** once a worker
  exists (registered bytes lag main), and delete stale schedule c8b6b7d0.
- **Customer harness is a named design partner** (`sales/harness` — authored on
  flows v2): its filed requirements rank gate work. First expected asks:
  `on()` triggers (gate 2), slack/notion helpers (gate 6), `f.human` channel
  delivery (covenant 3), memory scopes (gate 5).
- **PR titles from the pr step** leak the NEXT.md markdown header — use the
  work-package name.
- **The PR-shepherd flow (Garden component, gate 3):** when the Garden opens
  a PR, spawn a bounded-lifetime flow subscribed via relayfile to THAT PR
  only: `on(github.pr(N).review | .comment | .ci)` — each wake gets the
  original work-package requirements (ops/NEXT.md at PR time) + the new
  feedback in context, addresses findings from external reviewers (codex bot)
  and the relayflow review swarm (hoopsheet pattern), pushes fixes, replies,
  and closes itself at merge. The flow IS the PR's lifecycle. Khaliq,
  2026-08-27 — natural first real consumer of `on()` + relayfile PR trees.
- **Regression suite (`regressions/`, dormant):** red/green flow pairs for the
  four platform bugs found 2026-08-27 — enrollment-token bearer auth
  (cloud#3202), the `--daemon` `$bunfs` argv re-exec, RelayCron's `succeeded`
  into a void (covenant 2), and the cross-account 404 rendered as a permissions
  error (covenant 1). Written in the v2 dialect against a surface that does not
  exist yet; nothing runs until gates 1/2/6/7/8 close per `regressions/MANIFEST.json`.
  The Garden should adopt them once flows run in cloud.
- **`f.browser` helper (gate-6 family, plugin-shaped).** Escape hatch for the
  long tail: SaaS with no API, customer portals, vendor dashboards — what the
  50 relayfile adapters will never cover. Backed by the existing
  `browser-primitive` (kept deliberately by the 0825 charter). Ships under the
  plugin contract: compiles to kernel primitives, declares its preflight. NOT
  needed for the regression suite — asserting UI strings is brittle and tests
  the symptom; assert at the API where the condition is known.
- **Computer use — deferred, behind heavier rails.** Browser automation covers
  ~95%; desktop control adds native apps and installers. Highest-blast-radius
  primitive we could ship: unscoped clicking defeats path-scoped permissions
  (`workspace: readonly` means nothing if an agent can click Delete in a GUI).
  Needs per-run browser profile, no shared cookie jar, screen-region and app
  allowlists, and every action journaled as an effect before it is covenant-2
  compliant.
- **Upstream issues (2026-08-27):** cloud#3202 (bearer-auth enrolment,
  cross-account 404 messaging, cron-succeeded-into-void) · relay#1620
  (`--daemon` $bunfs argv crash + `worker status` blind to cloud liveness).
  Executable acceptance: `regressions/` on main.
- **Cloud sandbox runs die in `sync`: no git remote.** With the Relaycast 500
  cleared, cloud launches now provision a sandbox and execute the flow, then
  fail at `drive.yaml`'s first step: `fatal: 'origin' does not appear to be a
  git repository` (runs 9fc8d996, ff35187a, 06505b94 — 2026-08-27). The flow
  assumes a checkout with a remote, which holds locally and not in a fresh
  sandbox. Fix is flows-side: materialize the repo into the sandbox (relayfile
  github mount, as the personas do) or make `sync` clone when `origin` is
  absent. This is the last known gap between local ticks and machine-
  independent scheduled execution.
- **Documented `steps: []` check/kernel asymmetry (P3, WP-4 review V3).** The
  authoring surface refuses an empty step list —
  `REFUSED [invalid_spec] spec.steps: expected a non-empty array`, exit 2 —
  while the kernel accepts it: `RunSpec.steps` is `#[serde(default)]`
  (`kernel/relayflowd-core/src/spec.rs`, `RunSpec::steps`) and
  `RunSpec::validate` has no
  empty-steps check, so the loops no-op and it returns `Ok(())`. Same false-red
  class as the WP-5 F1 `name` case, and degenerate (a zero-step flow is
  meaningless; refusing it at authoring is defensible), so it was raised
  non-blocking. Close it by either refusing empty steps in the kernel too, or
  noting in `docs/SURFACE.md` that the authoring surface deliberately narrows
  this case. Deliberately not fixed in WP-5: the kernel option is out of scope.
- **Scope the `flows check` CLI probe environment (gate 8; WP-7 F6).** Gate 1
  intentionally discloses that `<cli> auth status` inherits the checker's
  complete caller environment. Gate 8 must replace ambient inheritance with
  an explicit scoped or allowlisted probe environment before untrusted or
  self-authored flow specs are checked under privileged credentials.

## Carried from PR #8 at squash (2026-08-28)

Eight findings stood open in the final passing transcript
(`ops/reviews/20260827-2331-pr8-maintainability.md`) and were not carried into
this ledger when #8 merged; the DRIVE-LOG called its three-item residual list
complete. Recorded here so they are tracked rather than lost — found by tick
12's reviewer (F4), which is exactly the kind of drop a squash makes invisible.

- **F1** — `probeFailedMessage`'s fall-through asserts *"timed out"* about any
  new detail. A wrong reason is worse than none: it sends the operator to fix
  a timeout that did not happen.
- **F2** — two probe timeouts duplicated per call site; the classifier's type
  does not bind them to the spawn option, so they can drift apart silently.
- **F3** — the `timeout:*` production path has no end-to-end coverage.
- **F5** — `every_failed_run_terminates_with_declared_completion_reasons`
  iterates a hand-maintained list; a new reason added without touching the list
  is untested (drift = silent regression, the registry lesson again).
- **F6** — `SpecError::InvalidTrigger` collapses two distinct faults into one
  message.
- **F8b** — `validateKernelRetry` names an authoring rule as if the kernel
  imposed it — a doc claim the kernel does not make.
- **F9** — `probeTrigger` catches every error with no classification, so a
  broken probe environment is indistinguishable from a bad trigger.
- **F10** — small load-bearing boundary details a reader will trip over.

Rule this produced: **a merge must not shrink the open-findings ledger.** What
a review leaves open moves here before the PR closes, or it is lost.

## Cloud sandbox verify gaps (2026-08-28, captured from run 404a8386)

The first cloud tick reached `verify` — sync ✅, assess ✅ (claude), build ✅
(codex) — and failed there on two environment facts, both ours to fix:

```
Step "verify" failed: /usr/bin/zsh: line 6: ../ops/cargo.sh: Permission denied

> @relayflows/sdk@0.1.0 test
> tsc --noEmit && vitest run
error TS2688: Cannot find type definition file for 'node'.
```

- **The executable bit does not survive the snapshot upload.** `ops/cargo.sh`
  arrives non-executable. Invoke it as `sh ops/cargo.sh` (or restore the mode
  in-step) rather than depending on file mode — the same "reproducible by
  construction, not by ambient file mode" rule a reviewer already made us
  learn once on a clean checkout.
- **`sdk/node_modules` is absent.** The snapshot carries `git ls-files`, so
  dependencies are not there. `verify` must install (`npm ci`) when
  `node_modules` is missing, and fail closed with a typed reason if install
  itself fails.

Both must hold on a laptop AND in a sandbox; a fix that only works in one is
the defect it replaces.

## A review that lands after the work cannot steer it (2026-08-28)

Tick 15b recorded an ordering fault against itself: the review meant to steer
its implementation landed 02:58, fifteen minutes *after* implementation began
at 02:43. This is structural, not incidental — `drive.yaml`'s DAG runs
`review` after `build`, so any review commissioned to validate a *plan* is
guaranteed to arrive too late to change it.

Two candidate shapes, to decide deliberately:
- **Gate the plan, not just the diff:** add a `plan-review` step between
  `assess` and `build`, cheap and scoped to the work package's reasoning. Tick
  15b's own assessment carried two substantive errors (an overstated RFC
  mandate, a wrong claim about the wire format) that a plan review would have
  caught before 25 minutes of building.
- **Accept it and stop pretending:** if review only ever judges the diff, then
  a tick must not describe its review as steering the implementation.

Either is honest. The current state — a post-hoc review described as guidance
— is the thing to remove.

## `ops/cargo.sh`'s shared CARGO_HOME serializes concurrent runs (2026-08-28)

Tick 16's `verify` hung 54 minutes at **0.0% CPU with 0.10s of CPU time**,
holding `flows/.cargo-home/.global-cache`. Not compiling — blocked. Killing it
let the step fail cleanly and the runner retry.

Cause: the de-vendoring fix pointed `CARGO_HOME` at one repo-local directory
so builds are hermetic. Every cargo invocation now contends for that single
package-cache lock, and this program routinely runs cargo in several worktrees
at once (a tick's verify plus an operator's independent verification). Hermetic
and concurrent are not free together.

Options, to decide rather than patch reflexively:
- per-worktree `CARGO_HOME` (isolated, costs disk and re-download)
- a lock-wait timeout in `ops/cargo.sh` that fails fast with a typed message
  instead of hanging past the step budget
- both: isolate, and still fail fast if a lock is somehow held

Whatever is chosen, the failure must be legible: a build that hangs at 0% CPU
for an hour told us nothing until someone read `ps`.

## Ten consecutive rejections; the last three were about the account, not the code (2026-08-28)

Ticks 8–17 all ended `VERDICT_FAILED`. The findings shrank steadily — broken
feature → inert binary → non-reproducing test → unverifiable claim → one
mis-attributed output block → an inverted mechanism description with a wrong
line citation. That is convergence, and every rejection named something real.

But the last three rejections were against the **assessment's account of the
work**, not the work: a mutation-verified label that did not reproduce, a
`gh pr list` block attributed to the wrong command, an inverted B1.3 mechanism
with an unrelated citation, and an asserted absence that did not reproduce.
The code under them passed its gates each time.

**The tuning question for Khaliq, deliberately left open:** should a defect in
the *description* block a merge as hard as a defect in the *behavior*?

- Keep as-is: the account is part of the deliverable; a wrong claim in a report
  is how a reviewer is deceived, and this program has been burned by exactly
  that (a green bot that reviewed nothing, a verify that ran nothing).
- Split the verdict: behavior-blocking findings stop the run; account-blocking
  findings become required errata on the PR but do not block. Risk: the errata
  queue becomes the place true claims go to be ignored.

Recording rather than choosing: relaxing a standard at 06:00 while the author
is asleep is exactly the move this program's rails exist to prevent.

## The watchdog already runs in cloud; only the work loop does not (2026-08-28)

Confirmed on a production flow, not a probe: `flows-watchdog` executed in a
cloud sandbox and reported `WATCHDOG_DONE`, 1 passed / 0 failed (run
`c018760b`). It is a single-agent flow with no git operations, so it never
touches the materialization gap that kills `drive.yaml` at `sync`.

Consequence worth stating plainly: **the liveness and escalation layer is
already laptop-independent.** If the drive loop stops, the watchdog still
notices and reports. What remains laptop-bound is the work loop, and only
because a scheduled run's workdir (`/project/workflows/schedules/<id>`) has no
repo — manual runs (`/project/workflows/runs/<id>`) do get the snapshot.

Also unresolved: `agent-relay cloud logs <run>` returns 500 for the most recent
scheduled drive run, so its outcome is unknown rather than assumed. With
`neonctl` auth expired there is currently no fallback for reading run state.

## `cloud logs` 500 is an opaque storage read, not a lost run (2026-08-28)

Reproduced and then un-reproduced: `agent-relay cloud logs 1bba6866` returned
500 while the run was settling and returns the full log now. The run itself was
never lost — the control plane had it the whole time (`workflow_runs.status =
failed`, `exit code 78 SYNC_FAIL_NOT_MATERIALIZED`), which is the same
scheduled-workdir gap already filed, not a new failure mode.

The 500 comes from the generic catch in
`cloud/packages/web/app/api/v1/workflows/runs/[runId]/logs/route.ts:181-190`.
Only `NoSuchKey` / `NotFound` are handled specially (returning empty content);
every other storage error falls through to `{ error: "Failed to read logs" },
{ status: 500 }`. So "the log object is not readable yet" and "object storage
is broken" are indistinguishable to a caller.

What I could not determine: which storage error actually fired. The detail goes
to `console.error` server-side, and I have no access to those logs — so this is
a located fault, not a diagnosed one.

**Operational consequence for us:** a 500 from `cloud logs` is not evidence
about the run. Read `workflow_runs` directly (neonctl → psql) before drawing any
conclusion about whether a run progressed.

## I reproduced the pipe-status bug in my own hands (2026-08-28)

Running `git checkout -q main 2>&1 | tail -2 && git reset -q --hard origin/main`
in the primary checkout: the checkout **failed** (`fatal: 'main' is already used
by worktree at '/private/tmp/flows-ops'`), but a pipeline's exit status is the
status of its *last* command, so `tail` returned 0 and the `&&` proceeded. The
reset then ran on the still-checked-out `flow/drive-c52d6df-08280519`,
discarding a modified `ops/NEXT.md` and the staged
`ops/reviews/20260828-0605-review.md`.

This is the *same* fault the `verify` step was hardened against
(`workflows/drive.yaml`: "Never pipe a test command into tail inside the status
check: the pipeline's status is tail's"). Knowing the rule and writing the
transcript of it did not stop me from doing it by hand ten hours later.

**Recovered:** the staged review survived as an unreachable blob
(`git fsck --unreachable`, blob `f7848f8`) and is restored in this commit —
249 lines, verdict `REVIEW_FAILED`. Nothing on `origin` was lost: the branch
pointer moved locally only, and origin still held `c52d6df`.

**Standard to apply, not just to gates:** never join a status-bearing command to
a formatter with a pipe. Capture first, format second:
`out=$(cmd 2>&1); rc=$?; echo "$out" | tail -2; [ $rc -eq 0 ] || exit 1`.
A rule that lives only inside one YAML step is a rule the operator will break.

## Cancelling a cloud run destroys its work (2026-08-28)

`agent-relay cloud sync <runId>` on a cancelled run returns
`409 Conflict: Run is still in progress. Patch is available after completion.`
— permanently. The run reads `cancelled` in `workflow_runs`, but the patch
endpoint never treats it as complete. Verified on three cancelled runs
(a89f78bf, 60508128, 457a6102): all yield zero files.

**A `failed` run keeps its patch** — f18ec684 failed and its work was
retrieved and delivered as PR #13. So the distinction is cancel-vs-fail, not
success-vs-failure.

**Operational consequence, learned the expensive way:** several runs were
cancelled today because they were doomed on a known-fixed fault, and their work
went with them. Do not cancel a run that has produced anything. Prefer letting
it fail on its own — a failure is recoverable, a cancellation is not.

The exception is a genuinely hung run. Steps outlive their `timeoutMs` without
being killed (observed three times: verify-1 at 31min/20min bound, review-1 at
36min/30min, plus an unbounded install of my own), so a hung run may never
reach a state where its patch is available. There the work is unreachable
either way and cancelling at least frees the budget.

**Worth filing against cloud:** cancel should finalize a run so its patch stays
retrievable. Work that reached a commit inside the sandbox is real, and losing
it to an operator's cancel is a silent data loss.

## A kernel test hangs intermittently under sandbox timing (2026-08-28)

`an_entry_appended_during_watch_registration_is_delivered_exactly_once`
(`kernel/relayflowd/src/server/tests.rs:209`) ran past 60 seconds in a cloud
sandbox, including when run alone. The same test passes locally in 0.54s
(19/19) and passed in cloud earlier the same day on run a89f78bf.

So it is a **race in watch registration**, not a deterministic failure: an
entry appended while a watch is being registered must be delivered exactly
once, and the coordination between those two paths can evidently deadlock
under different timing. This is gate-1 code that is marked GREEN, and the bug
is real regardless of how rarely it shows.

Found by the drive loop, not by us — the builder ran the definition-of-done
commands, hit the hang, and refused to report BUILD_DONE with the literal
output attached. That is the evidence standard working unsupervised.

**Next step:** reproduce under load (`--test-threads=1`, and repeated runs
under `stress`/`taskset`) rather than assuming it is unreproducible locally.
A test that hangs is worse than one that fails: it consumes a whole run.

## Removed the flows-drive-v3 schedule — it could only ever fail (2026-08-28)

Deleted schedule `9bc4a577`. It fired `drive-tick` every 4 hours and died at
`SYNC_FAIL_NOT_MATERIALIZED` every single time, because a SCHEDULED run's
workdir (`/project/workflows/schedules/<id>`) contains no repo — only manual
runs get the uploaded snapshot. It has never once done work.

Keeping it cost more than the zero it produced: every failure looked like a
real failure in run listings, and both the autopilot and the hang sweeper had
to reason about runs that were dead on arrival.

**This is not a decision to stop scheduling drive work.** It is deferred until
cloud can materialize code for scheduled runs — see the entry above on that
gap. Until then the loop is fed by `ops/launch-gate.sh` (manual runs, which do
get a snapshot) from a host that can upload.

Still active and working: `flows-watchdog` (daily digest) and
`flows-hang-sweeper` (every 30 min) — both single-agent flows that need no
repo, which is exactly why they succeed where drive-tick cannot.

## A cloud sandbox cannot run the agent-relay CLI — no cloud-side supervision (2026-08-28)

Removed `workflows/hang-sweeper.yaml` and its schedule. The idea was a
cloud-resident floor that would cancel hung runs even with every laptop and
mini offline. It cannot work, and now we know why literally — the sweeper's own
output:

```
SWEEPER_EVIDENCE:
To authorize this machine, visit:
  https://agentrelay.com/cloud/device
**SWEEPER_BLIND**
```

A workflow sandbox is not authenticated with Agent Relay Cloud, and the device
flow needs a human. So no scheduled workflow can inspect, cancel, or launch
runs. **Cloud-side supervision of cloud runs is not currently possible.**

Two lessons, both about gates rather than about cloud:

1. The first version reported `SWEEPER_DONE` after inspecting nothing, for two
   consecutive ticks, while a run hung for 67 minutes. Its gate was
   `output_contains: SWEEPER_DONE` — a token the agent emits regardless. A
   gate that cannot fail is not a gate, and it was built into the very thing
   meant to catch failures.
2. The second version keyed on `flows-hang-sweeper` appearing in output. It
   still passed a `SWEEPER_BLIND` run, because that string appeared in the
   agent's own prose. **Keying a gate on a string that can appear in narration
   is not evidence.** A real evidence gate must key on something only the tool
   can produce.

Supervision therefore lives on a fleet node (the autopilot) or a laptop. That
is a single point of failure and should be named as one rather than papered
over with a guard that does not guard.

## A sandbox can silently discard every file an agent writes (2026-08-29)

Run a2089144 failed all three assess-gate retries with
`ASSESS_FAIL_STALE_NEXT`, and its final patch contained **zero changed files**.
The Lead had done the work and said so:

> "Now I have written ops/NEXT.md as required by the Lead charter.
>  **WP-17: Make hn-monitor actually monitor** ..."

So the agent wrote the file, reported truthfully, and the write vanished — not
merely failing to propagate to the next step, but absent from the run's patch
entirely. The related log line seen earlier is
`relayfile flush failed after the command succeeded (exit 1); a later agent
step may see stale files`.

**Not universal.** Run b4e2c3fb, an hour earlier, delivered five files cleanly
and became PR #15. So this is per-sandbox, and a retry lands in the same
unhealthy sandbox — which is why all three attempts failed identically rather
than one recovering.

**Why it matters beyond this loop:** a step can succeed, report honestly, and
lose its output, with nothing in the step's own result indicating loss. Any
workflow on this platform that assumes "step succeeded" implies "step's writes
survived" is wrong. `assess-gate` catches it here only because it re-reads the
file from disk and compares against the base commit.

Mitigation available to us: none platform-side. Relaunching lands in a fresh
sandbox, which usually is healthy. Worth filing against cloud.

## BUILD_DONE is not evidence that anything was built (2026-08-29)

Run 2560e02d completed a full cycle and reported `BUILD_DONE`, and its patch
contained exactly one substantive file: `ops/NEXT.md`, the work package itself.
Every other changed path was an exec-bit strip (`100755 -> 100644`) caused by
the sandbox, not by the builder. No hn-monitor code was written despite that
being the whole target of the run.

This is the same shape as the hang sweeper that reported `SWEEPER_DONE` after
inspecting nothing: **a completion token the agent emits regardless of whether
work happened.** The verify step cannot catch it either — a build that changes
nothing leaves the existing suites passing, so verify goes green on an empty
build.

What a fix looks like (deliberately NOT applied at 02:00 after a long chain of
changes — this needs a clear head):
- a `build-gate` step, mirroring `assess-gate`, that fails when
  `git diff --stat main..HEAD` shows no change outside `ops/` — the builder
  must have touched code, not just prose;
- and it must ignore mode-only changes, or the sandbox's exec-bit stripping
  will make an empty build look productive.

Until that exists, treat `BUILD_DONE` as "the builder finished", never as "the
builder produced something". The loop currently RUNS reliably; whether it
PRODUCES is a separate question and this gate is why we cannot yet answer it
from the run's own output.
