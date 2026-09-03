# V2 run cancellation — captured evidence

Scope: `feat/v2-run-cancel`. Commands ran from this worktree on 2026-09-02.
Rust commands ran from `kernel/`; SDK commands ran from `sdk/`.

## Mutation check: cancellation priority removed

The specific three-line `cancel_requested` priority branch in
`relayflowd-core/src/machine.rs` was removed with `apply_patch`, the focused
core and real-process/socket tests were run, and the branch was then restored
byte-for-byte with `apply_patch`.

```text
$ CARGO_TARGET_DIR=/tmp/flows-v2-cancel-target cargo test -p relayflowd-core cancel_request -- --nocapture

running 2 tests
test machine::tests::repeated_cancel_request_is_idempotent ... ok
test machine::tests::cancel_request_closes_the_active_lease_before_the_terminal_fact ... FAILED

thread 'machine::tests::cancel_request_closes_the_active_lease_before_the_terminal_fact' panicked at relayflowd-core/src/machine/tests.rs:159:42:
index out of bounds: the len is 0 but the index is 0

failures:
    machine::tests::cancel_request_closes_the_active_lease_before_the_terminal_fact

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 26 filtered out
MUTATION_CORE_EXIT=101

$ CARGO_TARGET_DIR=/tmp/flows-v2-cancel-target cargo test -p relayflowd cancel_ -- --nocapture

running 3 tests

thread 'concurrency::cancel_closes_the_lease_and_rejects_a_late_completion' panicked at relayflowd/tests/crash_resume/concurrency.rs:141:5:
assertion `left == right` failed
  left: Null
 right: "canceled"
test concurrency::cancel_closes_the_lease_and_rejects_a_late_completion ... FAILED
test concurrency::cancel_and_completion_race_has_one_terminal_fact ... ok

thread 'sigkill_after_cancel_request_resumes_to_one_canceled_fact' panicked at relayflowd/tests/crash_resume.rs:212:5:
assertion `left == right` failed
  left: Completed
 right: Failed
test sigkill_after_cancel_request_resumes_to_one_canceled_fact ... FAILED

failures:
    concurrency::cancel_closes_the_lease_and_rejects_a_late_completion
    sigkill_after_cancel_request_resumes_to_one_canceled_fact

test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 19 filtered out
MUTATION_LIVE_EXIT=101
```

## Restored focused pass

```text
$ CARGO_TARGET_DIR=/tmp/flows-v2-cancel-target cargo test -p relayflowd-core cancel_request -- --nocapture

running 2 tests
test machine::tests::repeated_cancel_request_is_idempotent ... ok
test machine::tests::cancel_request_closes_the_active_lease_before_the_terminal_fact ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out
RESTORED_CORE_EXIT=0

$ CARGO_TARGET_DIR=/tmp/flows-v2-cancel-target cargo test -p relayflowd cancel_ -- --nocapture

running 3 tests
test concurrency::cancel_closes_the_lease_and_rejects_a_late_completion ... ok
test sigkill_after_cancel_request_resumes_to_one_canceled_fact ... ok
test concurrency::cancel_and_completion_race_has_one_terminal_fact ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 19 filtered out
RESTORED_LIVE_EXIT=0
```

The final focused kernel pass also pins that a durable cancel request outranks
crash recovery for an active lease:

```text
$ CARGO_TARGET_DIR=/tmp/flows-v2-cancel-target cargo test -p relayflowd-core cancel -- --nocapture
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.60s
     Running unittests src/lib.rs (/tmp/flows-v2-cancel-target/debug/deps/relayflowd_core-eb215c870b5b8c71)

running 3 tests
test machine::tests::repeated_cancel_request_is_idempotent ... ok
test machine::tests::cancel_request_closes_the_active_lease_before_the_terminal_fact ... ok
test machine::tests::durable_cancel_request_outranks_crash_recovery ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.00s

     Running tests/spec_parity.rs (/tmp/flows-v2-cancel-target/debug/deps/spec_parity-25916cc116a7848d)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.00s

FINAL_CORE_CANCEL_EXIT=0
```

## Full Rust regression and lint

```text
$ CARGO_TARGET_DIR=/tmp/flows-v2-cancel-target cargo clippy --workspace --all-targets -- -D warnings && CARGO_TARGET_DIR=/tmp/flows-v2-cancel-target cargo test --workspace --quiet
    Checking relayflowd-core v0.1.0 (/Users/khaliqgant/AgentWorkforce/flows-v2-cancel-wt/kernel/relayflowd-core)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 56.94s

running 22 tests
......................
test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 22 tests
......................
test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 1 test
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 1 test
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 3 tests
...
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 29 tests
.............................
test result: ok. 29 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 5 tests
.....
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 17 tests
.................
test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

## SDK typecheck/build and full regression

`npm` itself hung before printing its version on this host. The worktree had no
dependency directory, so the command used the already-installed dependency
tree from the sibling `flows-132-direct-input-wt` worktree (temporarily linked
as `sdk/node_modules`, then unlinked). It ran this worktree's compiler inputs,
config, source, built CLI, tests, and freshly-built cancellation-capable daemon.

```text
$ ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc && node scripts/make-cli-executable.mjs && RELAYFLOWD_BIN=/tmp/flows-v2-cancel-target/debug/relayflowd ./node_modules/.bin/vitest run

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-v2-cancel-wt/sdk

 ✓ tests/preflight.test.ts (14 tests) 31ms
 ✓ tests/validate.test.ts (36 tests) 70ms
 ✓ tests/backlog-picker.test.ts (14 tests) 317ms
 ✓ tests/journal-client.test.ts (14 tests) 172ms
 ✓ tests/cli-hn-monitor.test.ts (16 tests) 179ms
 ✓ tests/work-package-consumer.test.ts (13 tests) 963ms
 ✓ tests/hn-poller.test.ts (6 tests) 55ms
 ✓ tests/deterministic-llm.test.ts (5 tests) 137ms
 ✓ tests/dir-watcher-poller.test.ts (6 tests) 40ms
 ✓ tests/hello-deterministic.test.ts (5 tests) 164ms
 ✓ tests/work-package-validator.test.ts (7 tests) 60ms
 ✓ tests/backlog-picker-flow.test.ts (6 tests) 2582ms
 ✓ tests/parse-json-output.test.ts (7 tests) 12ms
 ✓ tests/cli.test.ts (50 tests) 2522ms
 ✓ tests/spec-parity.test.ts (15 tests) 180ms
 ✓ tests/bin.test.ts (7 tests) 2404ms
 ✓ tests/live-kernel.test.ts (18 tests) 56671ms

 Test Files  17 passed (17)
      Tests  239 passed (239)
   Duration  58.63s (transform 1.69s, setup 0ms, collect 5.49s, tests 66.56s, environment 9ms, prepare 6.70s)
```

After the final kernel ordering change, the full suite was rerun with file
parallelism disabled. This avoids exhausting the existing five-second timeout
in an unrelated live CLI case under parallel load. The analyzer skip variable
is the repository's documented allowance for a non-gate run; in this captured
run the real analyzer was available and executed successfully anyway.

```text
$ RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 RELAYFLOWD_BIN=/tmp/flows-v2-cancel-target/debug/relayflowd ./node_modules/.bin/vitest run --no-file-parallelism

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-v2-cancel-wt/sdk

 ✓ tests/live-kernel.test.ts (18 tests) 68166ms
 ✓ tests/cli.test.ts (50 tests) 1985ms
 ✓ tests/journal-client.test.ts (14 tests) 167ms
 ✓ tests/validate.test.ts (36 tests) 79ms
 ✓ tests/cli-hn-monitor.test.ts (16 tests) 93ms
 ✓ tests/preflight.test.ts (14 tests) 27ms
 ✓ tests/backlog-picker.test.ts (14 tests) 628ms
 ✓ tests/backlog-picker-flow.test.ts (6 tests) 1824ms
 ✓ tests/work-package-consumer.test.ts (13 tests) 724ms
 ✓ tests/deterministic-llm.test.ts (5 tests) 46ms
 ✓ tests/bin.test.ts (7 tests) 1267ms
 ✓ tests/hn-poller.test.ts (6 tests) 20ms
 ✓ tests/dir-watcher-poller.test.ts (6 tests) 15ms
 ✓ tests/hello-deterministic.test.ts (5 tests) 66ms
 ✓ tests/work-package-validator.test.ts (7 tests) 10ms
 ✓ tests/spec-parity.test.ts (15 tests) 91ms
 ✓ tests/parse-json-output.test.ts (7 tests) 7ms

 Test Files  17 passed (17)
      Tests  239 passed (239)
   Duration  89.31s (transform 1.02s, setup 0ms, collect 2.93s, tests 75.22s, environment 8ms, prepare 3.47s)
```

The parallel rerun immediately before that was not counted as a pass. It
reported one pre-existing five-second timeout under load; the same test passed
alone in 2.17 seconds:

```text
$ RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 RELAYFLOWD_BIN=/tmp/flows-v2-cancel-target/debug/relayflowd ./node_modules/.bin/vitest run

 Test Files  1 failed | 16 passed (17)
      Tests  1 failed | 238 passed (239)
   Duration  74.79s (transform 3.32s, setup 0ms, collect 11.22s, tests 92.34s, environment 15ms, prepare 7.39s)

$ RELAYFLOWD_BIN=/tmp/flows-v2-cancel-target/debug/relayflowd ./node_modules/.bin/vitest run tests/live-kernel.test.ts -t 'runs rung \(a\), parks rung \(b\)'

 ✓ tests/live-kernel.test.ts (18 tests | 17 skipped) 2174ms
   ✓ built flows CLI against live relayflowd > runs rung (a), parks rung (b), and keeps JSON report-shaped 2170ms

 Test Files  1 passed (1)
      Tests  1 passed | 17 skipped (18)
   Duration  3.68s (transform 302ms, setup 0ms, collect 419ms, tests 2.17s, environment 0ms, prepare 191ms)
```

The focused full-stack client/server cancellation case was also run alone
after the final kernel change:

```text
$ RELAYFLOWD_BIN=/tmp/flows-v2-cancel-target/debug/relayflowd ./node_modules/.bin/vitest run tests/live-kernel.test.ts -t 'cancels over the real socket'

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-v2-cancel-wt/sdk

 ✓ tests/live-kernel.test.ts (18 tests | 17 skipped) 182ms

 Test Files  1 passed (1)
      Tests  1 passed | 17 skipped (18)
   Duration  1.75s (transform 293ms, setup 0ms, collect 408ms, tests 182ms, environment 0ms, prepare 245ms)
```

## Scoped formatting

```text
$ rustfmt --edition 2024 --check --config skip_children=true kernel/relayflowd-core/src/entry.rs kernel/relayflowd-core/src/lib.rs kernel/relayflowd-core/src/machine.rs kernel/relayflowd-core/src/machine/cancel.rs kernel/relayflowd-core/src/machine/recovery.rs kernel/relayflowd-core/src/machine/tests.rs kernel/relayflowd-core/src/state.rs kernel/relayflowd/src/engine.rs kernel/relayflowd/src/engine/remote.rs kernel/relayflowd/src/lib.rs kernel/relayflowd/src/main.rs kernel/relayflowd/src/server.rs kernel/relayflowd/src/server/cancel.rs kernel/relayflowd/src/server/client.rs kernel/relayflowd/src/server/session.rs kernel/relayflowd/tests/crash_resume.rs kernel/relayflowd/tests/crash_resume/concurrency.rs
RUSTFMT_SCOPED_EXIT=0
```
