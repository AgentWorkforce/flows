# NEXT — WP-10: `flows run` / `flows resume` — the authored ladder runs on the live kernel

Written by the Relayflow Lead on 2026-08-28 for branch
`flow/drive-77b2457-08280058` (base `77b2457`).

## Why this package, and nothing else

**Standing directives:** `ops/DIRECTIVES.md` carries no directives today (five
lines, header only). Nothing outranks the gate work this tick.

**Open PRs:** none. `gh pr list --state open` returned empty; PR #8 merged as
`9e1d9eb`. No PR is awaiting fixes, so no PR-repair package pre-empts this one.

**The working tree holds unfinished work, and it does not build.** Six paths
are untracked on this branch, written at 00:28–00:32 and never committed:

```text
$ git status --porcelain
?? sdk/src/cli/
?? sdk/tests/journal-client-loopback.ts
?? sdk/tests/live-kernel.test.ts
?? testdata/hello-deterministic.flow.yaml
?? testdata/hello-deterministic.spec.canonical.json
?? testdata/hello-deterministic.spec.sha256
```

`sdk/src/cli/run.ts` implements `flows run` / `flows resume` over the journal
protocol; `sdk/src/cli/check.ts` is `check` extracted from `sdk/src/cli.ts`;
`sdk/tests/live-kernel.test.ts` drives the **built** `sdk/dist/cli.js` against a
live `relayflowd`. None of it is wired into `sdk/src/cli.ts`, and the SDK gate
is currently RED because of it:

```text
$ (cd sdk && npm test)
> tsc --noEmit && vitest run
src/cli/run.ts(3,15): error TS2305: Module '"../failure-kinds.js"' has no exported member 'RunFailureKind'.
```

Bypassing the typecheck shows the same break reaching two suites — the build
fixture in `bin.test.ts` fails, taking its seven tests with it, and the three
live-kernel cases fail because the built CLI has no `run` verb:

```text
$ (cd sdk && npx vitest run)
 ❯ tests/bin.test.ts (7 tests | 7 skipped) 750ms
 FAIL  tests/bin.test.ts [ tests/bin.test.ts ]
 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > runs rung (a), parks rung (b), and keeps JSON report-shaped
 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > preflights before journaling and names an unreachable socket
 FAIL  tests/live-kernel.test.ts > surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once
AssertionError: REFUSED [invalid_invocation] Usage: flows check [--json] <flow.yaml|spec.json>
 Test Files  2 failed | 7 passed (9)
      Tests  3 failed | 125 passed | 7 skipped (135)
```

The kernel is green and untouched by this:

```text
$ (cd kernel && ../ops/cargo.sh test --workspace)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
[exited with code 0]
```

**No new work over unfinished work** (`ops/AUTONOMY.md`). The unfinished work is
this feature. Finish it — do not delete it — because it closes the one seam
gate 1 has never crossed.

**What the seam is.** Gate 1 is GREEN in `ops/SCOREBOARD.md` on two bodies of
evidence that have never met:

- the kernel proves the ladder under `kill -9` using specs it authors itself —
  `kernel/relayflowd/tests/crash_resume/support.rs` builds a `crash-{name}`
  `run.json` inline, not `testdata/hello-*.flow.yaml`;
- the SDK proves it compiles the canonical ladder YAML to pinned bytes
  (`sdk/tests/spec-parity.test.ts` ⇄ `kernel/relayflowd-core/tests/spec_parity.rs`).

They are joined only by a checked-in canonical-JSON fixture and its sha256. No
test anywhere runs an **author-written flow file through the shipped `flows`
binary into a live `relayflowd`**. Gate 1 is named "a relayflow can run," and
`docs/SURFACE.md` §5 already documents `flows run` as the direct-call entry —
the surface is published and unimplemented. Every later gate's consumer
(gate 2's triggers, gate 3's garden, gate 6's helpers) invokes flows through
this path; it cannot stay a fixture.

## Objective

Land `flows run` and `flows resume` in the shipped CLI, and prove behaviorally
— through the built `sdk/dist/cli.js` against a live `relayflowd` — that the
canonical ladder rung (a) runs to `success`, that rungs (b)/(c) **park** with a
typed reason instead of silently succeeding, that a failed step terminates in a
declared `completionReason`, and that resuming after a real daemon kill
re-executes nothing already completed.

## Files in scope

- `sdk/src/failure-kinds.ts` — add the closed `RUN_FAILURE_KINDS` taxonomy and
  its `RunFailureKind` type. `run.ts` already emits `run_unavailable`,
  `daemon_unreachable`, and `protocol_error`; the union must be declared, the
  same shape as `PREFLIGHT_FAILURE_KINDS`, with a `isRunFailureKind` guard if
  the emitter needs one. This single missing export is what reddens the tree.
- `sdk/src/cli/run.ts`, `sdk/src/cli/check.ts` — the in-flight modules. Keep
  `check`'s behavior byte-identical to the merged `sdk/src/cli.ts` (its 42
  `cli.test.ts` cases are the contract); the extraction may not change one
  refusal string or exit code.
- `sdk/src/cli.ts` — becomes the dispatcher: `check` | `run` | `resume`, with
  `--json`, `--data-dir`, and a usage refusal that names all three verbs.
  Watch the 500-line rule: it is 311 lines today and the extraction is what
  keeps it under.
- `sdk/tests/live-kernel.test.ts`, `sdk/tests/journal-client-loopback.ts` —
  the end-to-end gate and the shared loopback harness.
- `sdk/tests/cli.test.ts` — unit coverage for the new verbs' argument parsing
  and exit codes against the loopback, not the daemon.
- `testdata/hello-deterministic.flow.yaml` + its `.spec.canonical.json` /
  `.spec.sha256` — rung (a) as a standalone runnable flow. Pin it on **both**
  sides of the parity gate: add `hello-deterministic` to the fixture loop in
  `sdk/tests/spec-parity.test.ts` and to
  `kernel/relayflowd-core/tests/spec_parity.rs`, or it is a fixture only one
  side has agreed to.
- `docs/SURFACE.md` — replace the §5 promise with what actually ships: the
  verbs, the exit codes, and the parked case.
- `ops/DRIVE-LOG.md`, `ops/SCOREBOARD.md` — the tick entry and the gate-1
  evidence row, updated to cite the live path rather than fixture parity.

## Design points this package must settle

1. **Exit codes are a contract, so write them down.** `run.ts` returns
   `0` success · `1` run failed or protocol error · `2` refused before any
   journal write · `3` parked. `docs/SURFACE.md` states them; a test asserts
   each one.
2. **Preflight runs before the journal.** `runFlow` calls `checkFlow` first and
   returns exit 2 without contacting the daemon. Covenant 2 says a refusal must
   precede the effect; the existing live test case "preflights before
   journaling and names an unreachable socket" is that assertion — keep it.
3. **Parked is a first-class outcome, not a hang.** `hello-llm` / `hello-agent`
   have no attached worker. The kernel already answers `RunStatus::Parked`
   (`kernel/relayflowd/src/engine/drive.rs`). The CLI must name the parked step
   and its type and exit 3. Silence here would be the Nabis silent-zero defect.
4. **A gate that skips is a gate that failed** (`ops/AUTONOMY.md`). If
   `RELAYFLOWD_BIN` (default `kernel/target/debug/relayflowd`) is missing,
   `live-kernel.test.ts` must **fail** with an actionable message naming the
   build command — never `it.skip`. The DoD command sequence therefore builds
   the kernel before running the SDK suite.
5. **Resume proves exactly-once, not just exit 0.** The resume case must assert
   from the journal that each completed step has exactly one `step.completed`
   entry after the kill+resume — the same bar
   `assert_exact_journal` holds the kernel to.

## Definition of done

Every command below run from a clean checkout of the branch, with its literal
output captured in `ops/DRIVE-LOG.md` per the evidence standard in `AGENTS.md`
("Evidence is captured, not narrated" — paste the output, not a summary of it).

1. `git status --porcelain` → **empty**. Nothing this package touches is left
   untracked; the six paths above are committed or deliberately removed with
   the removal explained in the log.
2. `(cd kernel && ../ops/cargo.sh test --workspace)` → exit 0, **≥ 72 passed,
   0 failed** (the current floor; the added `hello-deterministic` parity case
   raises it).
3. `(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)` → exit 0.
4. `(cd kernel && ../ops/cargo.sh fmt --check)` → exit 0, empty output.
5. `(cd kernel && ../ops/cargo.sh build)` → `kernel/target/debug/relayflowd`
   exists and is executable.
6. `(cd sdk && npm ci && npm run build && npm test)` → exit 0, **0 failed, 0
   skipped**, `Test Files` all passed. `bin.test.ts` must report 7 passed (not
   7 skipped) and `live-kernel.test.ts` must report its cases passed — a suite
   that skipped is not a suite that ran.
7. Behavioral proof through the built binary, captured verbatim — not through
   vitest, the same way gate 1's preflight clause was proven:
   - `node sdk/dist/cli.js run --data-dir <tmp> testdata/hello-deterministic.flow.yaml`
     → exit 0, stdout carries the run id and `completionReason: success`;
   - `node sdk/dist/cli.js run --data-dir <tmp> testdata/hello-llm.flow.yaml`
     → exit 3, stderr `PARKED [run_parked]` naming step `answer` (llm);
   - `node sdk/dist/cli.js run --data-dir <tmp> testdata/hello-agent.flow.yaml`
     → exit 3, parked at the agent step;
   - a flow whose step exits non-zero → exit 1, `FAILED [step_failed]`, and a
     journal terminating in a declared `completionReason`;
   - `node sdk/dist/cli.js run --data-dir <tmp> …` with no daemon listening
     → exit 2, `REFUSED [daemon_unreachable]`, and **no journal file created**;
   - `node sdk/dist/cli.js resume --data-dir <tmp> <run-id>` after
     `kill -9` of the daemon mid-run → exit 0, and the journal shows each
     completed step exactly once.
8. `docs/SURFACE.md` §5 describes the three verbs, the four exit codes, and the
   parked outcome, with no claim the shipped CLI does not honor.
9. No file in `sdk/src` or `kernel` crosses 500 lines:
   `find kernel sdk/src -name '*.rs' -o -name '*.ts' | grep -v target | xargs wc -l | sort -nr | head -5`
   captured in the log.
10. A PR is opened with this evidence in the body, titled by the work-package
    name (**not** the NEXT.md markdown header — that leak is a filed backlog
    item). The Lead does not merge; the merge bar in `ops/RUN-CONTRACT.md` §3
    governs whoever does.

## Explicitly OUT of scope for this tick

- **The eight findings carried from PR #8** (F1, F2, F3, F5, F6, F8b, F9, F10
  in `ops/BACKLOG.md`). They are `check`-path debt. Touching them here mixes a
  refactor's diff with a feature's and re-opens the review chronology that cost
  PR #8 six ticks. If the `check` extraction makes one of them a one-line
  obvious fix, still leave it: file the observation in the log instead.
- **Attaching a real worker for `llm` / `agent` steps.** Parked is the correct
  gate-1 answer; the worker is gate 2 / gate 4's `mount-as-writer`, which is
  also where `DESIGN.md` §1.9's double-effect residual closes.
- **The path-like deterministic-command refusal** (Codex P1) and the
  **`steps: []` check/kernel asymmetry** — both filed, both `check`-path.
- **Gate 2, 5, and 6 work**, including harness's slack/notion helpers, `on()`
  triggers, and `f.human`. `ops/SCOREBOARD.md` marks gate 6 "next up"; it stays
  next, not now.
- **The release pipeline** (cross-compiled `relayflowd` bundled into the npm
  package). This tick's live test may build the binary locally and read
  `RELAYFLOWD_BIN`; shipping it is a separate package.
- **The cloud-sandbox `sync` gap** (no git remote in a fresh sandbox) and
  re-registering cloud schedules. Both real, both filed, neither on the
  gate-1 critical path.
- **Any change to `docs/RFC-0001-everything-is-a-relayflow.md`,
  `ops/DIRECTIVES.md`, or a gate that judges this work.**

## A note for the tick that logs this

`ops/SCOREBOARD.md` currently reports gate 1 GREEN. This package does not
contradict that — the crash-resume and preflight clauses of §3's done-when are
genuinely met and independently verified. What it adds is the clause the gate's
own name implies and no test yet holds: that a *relayflow authored on the
published surface* is what runs. If this package lands, gate 1's evidence row
should cite the live path. If it fails, say so and leave the row alone —
a failed run is never reported as completed.

END_PACKAGE
