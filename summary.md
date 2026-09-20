# A failing named gate now says why (#507)

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
command; both would be scope the ticket did not ask for. This criterion should
be tracked against the Cloud repository.

## Validation

Run from `packages/sdk`. The kernel target lives outside the tree
(`ops/cargo.sh` redirects `CARGO_TARGET_DIR`), and `test:prep` exports
`RELAYFLOWD_BIN` inside a subshell that does not reach vitest, so it is passed
explicitly here.

Mutation verification — production file reverted with `git stash push
packages/sdk/src/named-gate-lowering.ts`, rebuilt, both new files run:

```
 ❯ tests/named-gate-diagnostics.test.ts (17 tests | 12 failed) 569ms
 ❯ tests/named-gate-journal.test.ts (5 tests | 1 failed) 1798ms
 Test Files  2 failed (2)
      Tests  13 failed | 9 passed (22)
```

The 9 that pass are the honest baseline: stream capture already worked.
Restored byte-for-byte with `git stash pop`, rebuilt, re-run:

```
 ✓ tests/named-gate-diagnostics.test.ts (17 tests) 545ms
 ✓ tests/named-gate-journal.test.ts (5 tests) 1629ms
 Test Files  2 passed (2)
      Tests  22 passed (22)
```

Required package command — `RELAYFLOWD_BIN=... npm test` (kernel build,
typecheck, build, test typecheck, vitest):

```
 ✓ tests/named-gate-diagnostics.test.ts (17 tests) 575ms
 ✓ tests/named-gate-journal.test.ts (5 tests) 1840ms
 ...
 Test Files  3 failed | 155 passed | 1 skipped (159)
      Tests  30 failed | 2393 passed | 17 skipped (2440)
```

**The 30 failures are pre-existing and unrelated.** Verified by running the
same files against the reverted production code: identical counts, identical
line numbers.

- `tests/authored-node-runtime.test.ts` — suite-level failure at line 18,
  `expected '1.3.6' to be '1.4.0'`: this sandbox's bun is older than the
  version the test pins. All 14 cases skip. This is the file that exercises
  `word_count_bounds` end-to-end, so it was checked first and specifically; it
  does not run here for want of a prerequisite, not because of this change.
- `tests/live-kernel.test.ts` — 8 cases needing agent CLIs unavailable here.
- `tests/stuck-run-triage.test.ts` — 22 cases failing in
  `getFlowDefinition` with "expected an @relayflows/surface flow handle", a
  surface module-resolution problem in this checkout.

No kernel code changed, so the Rust suite was not run.

`tsconfig.tests.json` gains the two new files so `typecheck:tests` covers them;
it passes clean. No file under `docs/evidence` and no generated file was
edited.
