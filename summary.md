# A failing named gate now says why (#511)

**Correction:** the ticket implemented here is **#511** ("A failing
`subprocess_gate` journals empty stdout/stderr"). The first commit on this
branch, `f308f95`, and the PR title and body cite **#507**, which is a
different open issue (`f.gitlab` is comment-only while `f.github` has full
writeback). That commit is already pushed and is not amended here; the number
is corrected in this report and in `evidence/511-named-gate-diagnostics/`. The
PR body needs the same correction, which is a remote write this change does not
make.

## What the ticket reported, and what the evidence actually shows

The ticket proposed replacing `stdio: 'inherit'` in `named-gate-lowering.ts`
with `spawnSync` buffering, on the theory that the daemon captures the gate
command's stdio nowhere.

**That is not what the code does, and the replacement would make things
worse.** `kernel/relayflowd/src/exec_det.rs:78` creates `Stdio::piped()` for
the deterministic step's stdout and stderr and drains both on reader threads.
The lowered gate *is* a deterministic step, so `inherit` hands the author's
command those very pipes. Its bytes reach the journal as they are written.

This is not an argument from reading alone. The new
`tests/named-gate-journal.test.ts` starts a real `relayflowd`, runs a lowered
`subprocess_gate`, and reads `step.completed.payload.output` back for the
generated `produce.gate` step. Both tails are there, on a failing gate and on
a passing one. Those two cases **passed against unmodified production code**.
The ticket's stated root cause does not reproduce here, and the reported
macOS incident has not been replayed; nothing below claims it has.

Buffering would also have cost something real: the kernel SIGKILLs the whole
process group on timeout, so output held for a post-wait flush is destroyed
exactly when it is the only account of the failure. `stdio: 'inherit'` is kept
and now has a regression test that pins it — a gate printing a marker and then
sleeping past a 750 ms timeout still journals the marker.

## The defect that is real: exits that say nothing

The gate program had five bare `process.exit(1)` sites, and `word_count_bounds`
four more. Each produced precisely the shape the ticket describes — `exit_code:
1`, empty `stdout_tail`, empty `stderr_tail` — but for reasons that have
nothing to do with the author's command:

- `from_output` / `in_output_at` selected a path the producer output does not
  have (the command never ran at all);
- the selected value could not be read as text;
- the text contained a NUL byte;
- `spawnSync` returned an `error` and never started the child (this is where
  an `E2BIG` would land);
- the child was killed by a signal, so `status` is `null`.

A `references_input` gate whose binding has drifted, and a `subprocess_gate`
whose producer changed shape, both report as "the gate failed" with nothing
attached. That is the undiagnosable failure, and it is now fixed.

## The change

`packages/sdk/src/named-gate-lowering.ts` only.

A `fail(message)` helper in the shared preamble writes **one bounded line to
fd 2** and exits 1. Every non-verdict exit routes through it. Specifics:

- **`writeSync(2, ...)`, not `process.stderr.write`.** On a pipe the latter is
  asynchronous and the `process.exit` on the same line would drop the
  diagnostic — losing the message precisely when it is the only evidence.
- **stderr only, never stdout.** `references_input` verifies via
  `output_contains` on stdout and `word_count_bounds` via an anchored decimal
  pattern, so one stray byte on fd 1 would change a verdict. Three tests assert
  stdout stays empty (or stays the bare count) when a diagnostic fires.
- **Bounded and single-line.** 400 characters, with `\r\n` collapsed to spaces,
  so an author-controlled label cannot forge extra log lines.
- **No input, environment, or raw error object is dumped.** Spawn failures
  carry the error *code* and the input's byte count, which is what makes an
  argument/environment-size failure diagnosable without printing the payload.

`word_count_bounds` additionally stops discarding its `wc` stderr: `error`,
`signal`, nonzero status and malformed output each get their own cause with a
bounded 200-byte suffix of what `wc` said. Previously a missing or broken `wc`
was indistinguishable from a word count out of bounds.

Deliberately **unchanged**, per the reviewed plan: `stdio: 'inherit'`, the
`FLOWS_INPUT` transport, exit normalization, verification predicates, the
journal schema, retry policy, and the NUL guard's two-layer escaping. Ordinary
predicate mismatches in `references_input` / `regex_match` / `artifact_exists`
keep their bare `exit 1` — a predicate that simply did not match is not a
capture failure and needs no new output.

## Tests

**`tests/named-gate-diagnostics.test.ts`** (17 cases) runs the *actual command
the compiler emits* — obtained through `compileSpec` + `lowerNamedGates`, not a
copied helper — under piped stdio. It covers stream capture on pass and fail,
each selection failure with a `THE-COMMAND-RAN` sentinel asserted **absent**,
NUL rejection (with a literal backslash-zero case proving legitimate input
still runs), SIGKILL, stdout non-contamination for every affected gate, and the
`wc` failure modes via a `PATH`-ordered shim.

The spawn-error case deserves a note. An oversized outer `FLOWS_INPUT` would
stop the *test's own* gate process from starting and prove nothing about the
inner spawn; a nonexistent command starts `/bin/sh` fine and exits 127. So the
test puts a `node` shim first on `PATH` that execs the real interpreter with
`--require`, and the preload hooks `Module._load` to return a
`node:child_process` whose `spawnSync` reports `E2BIG` with a null status. The
real serialized program runs against a stubbed syscall. No production injection
hook was added.

**`tests/named-gate-journal.test.ts`** (5 cases) is the acceptance evidence: a
live daemon, assertions on the persisted `step.completed` output of the
generated gate step. It covers a failing gate, a passing gate, a selection
diagnostic, partial tails surviving a timeout, and a gate on an **agent** step
— the incident's shape, where the envelope is selected whole rather than as
`stdout_tail`. That case also asserts the failing gate's stderr reaches the
authored failure report's message.

## Acceptance

| Ticket requirement | Status |
| --- | --- |
| Failing gate journals both tails | Met — `named-gate-journal.test.ts`, live daemon. Already true before this change; now pinned. |
| Passing gate journals both tails | Met — same file. Already true before; now pinned. |
| Failure report shows the cause | Met — agent-gate case asserts the marker in the authored failure message. |
| Test asserts journal capture of both streams | Met — committed assertions on persisted `output`. |
| Other lowered gates checked | Met — `word_count_bounds` was the other child-spawning gate and was blind to its own child's failure; fixed. `artifact_exists`, `regex_match`, `references_input` spawn nothing and need no change. |
| **`flows logs <run-id>` shows the failure** | **PENDING — not closed by this PR.** |

### Why `flows logs` is left open

`flows logs` is Cloud-only. `packages/sdk/src/cloud-read.ts:504` issues `GET
/api/v1/workflows/runs/<id>/logs`; there is no local-journal fallback, and
this repository contains **no producer** for that log — no write side of the
route exists here. `docs/CLOUD.md:449-452` states it directly: "what these
routes serve is Cloud's own record of the run, not the kernel journal."

A test could mock a log body containing these markers, but that would prove
only that the renderer prints what it is given — it could not show the gate's
stderr was ever published. The missing integration is the **Cloud runner /
harness that writes runner logs**, which lives outside this repository. I have
not substituted `flows replay` (local-journal only) or added a new local logs
command; both would be scope the ticket did not ask for.

**Tracking, stated precisely.** The work item is: *the Cloud runner (or the
harness that wraps it) must publish a deterministic step's `stdout_tail` and
`stderr_tail` into the body served by `GET
/api/v1/workflows/runs/<id>/logs`.* Closing it requires end-to-end evidence
from that producer — a real Cloud run whose lowered gate fails, and the
`flows logs <run-id>` output showing the gate's stderr — which cannot be
produced from this repository, because no code here writes that route.
Until that evidence exists, **#511 is not fully closed by this PR**; merging
it leaves that one acceptance bullet open. No follow-up issue was filed:
filing one is a remote write, and this change makes none. A maintainer should
open it against the Cloud repository and link it from #511.

## Validation

Every run below is in `evidence/511-named-gate-diagnostics/`, as the captured
output of the command that heads the file, ending in its exit status. The
earlier revision of this report quoted excerpts without the transcripts, the
full daemon path, or a baseline invocation; that is what these runs replace.
The runs are re-executions, not the earlier session's logs.

All commands run from `packages/sdk` with the same explicit environment —
`test:prep` exports `RELAYFLOWD_BIN` inside a subshell that never reaches
vitest, and the kernel target lives outside the tree because `ops/cargo.sh`
redirects `CARGO_TARGET_DIR`:

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd
```

### The required package command — [head-package-test.txt](evidence/511-named-gate-diagnostics/head-package-test.txt)

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd npm test
```

Kernel build, typecheck, build, test typecheck, vitest. Exit 1:

```
 ✓ tests/named-gate-diagnostics.test.ts (17 tests) 532ms
 ✓ tests/named-gate-journal.test.ts (5 tests) 1959ms
 Test Files  3 failed | 155 passed | 1 skipped (159)
      Tests  30 failed | 2393 passed | 17 skipped (2440)
```

**The package is not green in this sandbox.** The transcript is complete —
every failure's assertion and stack is in it, not summarized.

### Mutation verification — [mutation-reverted.txt](evidence/511-named-gate-diagnostics/mutation-reverted.txt), [mutation-restored.txt](evidence/511-named-gate-diagnostics/mutation-restored.txt)

Red half: revert the only production file to the parent revision, rebuild,
re-run both new files.

```sh
git checkout e21caad -- src/named-gate-lowering.ts
git hash-object src/named-gate-lowering.ts        # 479136c2… = e21caad's blob
npm run build && npx vitest run tests/named-gate-diagnostics.test.ts tests/named-gate-journal.test.ts
```

```
 ❯ tests/named-gate-diagnostics.test.ts (17 tests | 12 failed) 626ms
 ❯ tests/named-gate-journal.test.ts (5 tests | 1 failed) 1808ms
 Test Files  2 failed (2)
      Tests  13 failed | 9 passed (22)
EXIT=1
```

The 9 that pass are the honest baseline: stream capture already worked before
this change. Green half, with the restore identity checked rather than
asserted:

```sh
git checkout HEAD -- src/named-gate-lowering.ts
git hash-object src/named-gate-lowering.ts        # 8a4ac50391d95c95693eb20cdbc69869a5d02060
git rev-parse HEAD:packages/sdk/src/named-gate-lowering.ts
                                                  # 8a4ac50391d95c95693eb20cdbc69869a5d02060
git status --porcelain -- src tests tsconfig.tests.json   # empty
npm run build && npx vitest run tests/named-gate-diagnostics.test.ts tests/named-gate-journal.test.ts
```

```
 ✓ tests/named-gate-diagnostics.test.ts (17 tests) 685ms
 ✓ tests/named-gate-journal.test.ts (5 tests) 1929ms
 Test Files  2 passed (2)
      Tests  22 passed (22)
EXIT=0
```

Equal hashes and an empty `git status` are what makes "byte-for-byte" a
checkable statement rather than a claim.

### The 30 failures, with a baseline — [head-isolated-three-files.txt](evidence/511-named-gate-diagnostics/head-isolated-three-files.txt), [baseline-in-place-e21caad.txt](evidence/511-named-gate-diagnostics/baseline-in-place-e21caad.txt)

The three failing files, run alone at head and then again with `packages/sdk`
reverted to `e21caad` **in the same working directory**, so the revision is the
only variable:

```sh
# head (f308f95)
npx vitest run tests/live-kernel.test.ts tests/stuck-run-triage.test.ts tests/authored-node-runtime.test.ts
#   Test Files  3 failed (3)
#        Tests  30 failed | 23 passed | 14 skipped (67)

# baseline (e21caad), same directory:
git checkout e21caad -- packages/sdk
rm packages/sdk/tests/named-gate-diagnostics.test.ts packages/sdk/tests/named-gate-journal.test.ts
git diff --stat e21caad -- packages/sdk            # empty
npm run build && npx vitest run tests/live-kernel.test.ts tests/stuck-run-triage.test.ts tests/authored-node-runtime.test.ts
#   Test Files  3 failed (3)
#        Tests  30 failed | 23 passed | 14 skipped (67)
```

Same counts, same cases, same assertion line numbers, at both revisions. That
is the evidence for "pre-existing"; the tree was then restored and the identity
re-checked ([restore-identity.txt](evidence/511-named-gate-diagnostics/restore-identity.txt):
all four changed blobs hash-equal to `HEAD`, `git status --porcelain` empty).

Why each fails here:

- `tests/stuck-run-triage.test.ts` — 22 cases throwing "expected an
  `@relayflows/surface` flow handle". Two installs of that package are
  reachable from this checkout, and node resolves the test and the workflow
  under test to different ones, so the handle is absent from the `WeakMap` the
  test's copy of `getFlowDefinition` consults
  (`packages/surface/src/flow.ts:137-143`). Literal resolution output is in
  [unrelated-failure-cause.txt](evidence/511-named-gate-diagnostics/unrelated-failure-cause.txt):
  the test resolves inside the checkout, the workflow resolves to
  `/home/daytona/.relayflow-v2-supervisor/durable/node_modules`, an ancestor of
  it. A sandbox layout defect.
- `tests/live-kernel.test.ts` — 8 cases needing agent CLIs unavailable here.
- `tests/authored-node-runtime.test.ts` — suite-level failure at line 18,
  `expected '1.3.6' to be '1.4.0'`: this sandbox's bun is older than the
  version the test pins, so all 14 cases skip. This is the file that exercises
  `word_count_bounds` end-to-end, so it was checked first and specifically; it
  does not run here for want of a prerequisite.

A third run, [baseline-e21caad.txt](evidence/511-named-gate-diagnostics/baseline-e21caad.txt),
ran the same three files at `e21caad` in a `/tmp` worktree and saw only 1
failure. It is reported but **not** used as the baseline: `/tmp` has no
ancestor `@relayflows` install, so it changes the resolution above and does not
hold the environment fixed.

### Not run

The Rust suite: no kernel code changed
(`git diff --stat e21caad HEAD -- kernel` is empty). Any Cloud runner-log
publication: no producer exists here, as recorded above. The reported macOS
incident: not replayed, on Linux or anywhere.

`tsconfig.tests.json` gains the two new files so `typecheck:tests` covers them;
it passes inside the `npm test` transcript. No file under `docs/evidence` and
no generated file was edited.
