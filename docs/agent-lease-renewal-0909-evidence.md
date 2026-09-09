# AgentWorker lease renewal — 2026-09-09

AgentWorker renews each dispatched attempt through `step.heartbeat` at 10-second
intervals, without overlapping requests. CLI settlement and worker close stop
renewal; already-sent renewals settle before completion is submitted. A renewal
failure stops the heartbeat, preserves CLI output in a `worker_error` completion,
and surfaces through the worker error event after settlement. If completion also
fails, both errors are retained in an AggregateError. Close deliberately stops
renewing even while a CLI drains, so closing a long-running step can expose a
lease conflict.

Scope: SDK worker only; no kernel, gate, timeout constant, or workflow changes.
The live fixture is a real subprocess lasting 34 seconds, using the supplied
prebuilt kernel. It does not call Claude or run the full drive workflow. The
600,000ms case uses a simulated clock. The live test is opt-in via
`RELAYFLOWD_BIN`; the deterministic lifecycle tests run by default.

Base: `863c37b`. Commands below run from `/Users/khaliqgant/fl-lease/packages/sdk`
unless a different directory is shown. Logs are literal captured output.

## Reproduction before implementation

Command:
```sh
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3497393500/debug/relayflowd node node_modules/vitest/vitest.mjs run tests/worker-heartbeat-live.test.ts
```
Captured output (test runner failed):
```text

 RUN  v2.1.9 /Users/khaliqgant/fl-lease/packages/sdk

stdout | tests/worker-heartbeat-live.test.ts > journals success after a real CLI runs beyond the 30-second lease
{"renewals":0,"errors":["JournalProtocolError: lease_conflict: attempt has no active worker lease","JournalProtocolError: lease_conflict: attempt has no active worker lease"]}

 ❯ tests/worker-heartbeat-live.test.ts (1 test | 1 failed) 64529ms
   × journals success after a real CLI runs beyond the 30-second lease 64528ms
     → expected [ …(2) ] to deeply equal []

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/worker-heartbeat-live.test.ts > journals success after a real CLI runs beyond the 30-second lease
AssertionError: expected [ …(2) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   [JournalProtocolError: lease_conflict: attempt has no active worker lease],
+   [JournalProtocolError: lease_conflict: attempt has no active worker lease],
+ ]

 ❯ tests/worker-heartbeat-live.test.ts:53:20
     51|     const terminal = journal.find(entry => entry.entry_type === 'run.c…
     52|     console.log(JSON.stringify({ renewals: heartbeat.mock.calls.length…
     53|     expect(errors).toEqual([]);
       |                    ^
     54|     expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
     55|     expect(terminal).toMatchObject({ payload: { completionReason: 'suc…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  15:07:30
   Duration  64.79s (transform 58ms, setup 0ms, collect 97ms, tests 64.53s, environment 0ms, prepare 27ms)

```

## Remove the fix, observe failure, restore byte-for-byte

The following commands ran from the repository root. At this point HEAD was
still `863c37b`; replacing worker.ts removes the only heartbeat call site. The
new helper remains unused. The fixed file was restored even though the test
runner exited 1.

```sh
cp packages/sdk/src/worker.ts /tmp/lease-renewal-0909-evidence/worker.fixed.ts
shasum -a 256 packages/sdk/src/worker.ts > /tmp/lease-renewal-0909-evidence/restore-before.txt
git show HEAD:packages/sdk/src/worker.ts > packages/sdk/src/worker.ts
cd packages/sdk
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3497393500/debug/relayflowd node node_modules/vitest/vitest.mjs run tests/worker-heartbeat.test.ts tests/worker-heartbeat-live.test.ts > /tmp/lease-renewal-0909-evidence/mutation-red.txt 2>&1
result=$?
cp /tmp/lease-renewal-0909-evidence/worker.fixed.ts src/worker.ts
cat /tmp/lease-renewal-0909-evidence/mutation-red.txt
exit $result
```
Captured output (exit 1):
```text

 RUN  v2.1.9 /Users/khaliqgant/fl-lease/packages/sdk

 ❯ tests/worker-heartbeat.test.ts (11 tests | 9 failed) 12ms
   × AgentWorker lease heartbeat > completes an agent step lasting 34000 simulated ms 5ms
     → expected [ Error: lease expired ] to deeply equal []
   × AgentWorker lease heartbeat > completes an agent step lasting 600000 simulated ms 1ms
     → expected [ Error: lease expired ] to deeply equal []
   × AgentWorker lease heartbeat > stops renewing when CLI execution throws 0ms
     → expected "spy" to be called 1 times, but got 0 times
   × AgentWorker lease heartbeat > stops renewing at close even while the CLI is still running 0ms
     → expected "spy" to be called 1 times, but got 0 times
   × AgentWorker lease heartbeat > surfaces a renewal failure and still submits the CLI result 0ms
     → expected "spy" to be called 1 times, but got 0 times
   × AgentWorker lease heartbeat > does not overlap renewals or complete before a pending renewal settles 0ms
     → expected "spy" to be called 1 times, but got 0 times
   × AgentWorker lease heartbeat > retains renewal and completion errors together 1ms
     → expected Error: completion failed to be an instance of AggregateError
   × AgentWorker lease heartbeat > keeps another dispatch renewing when the first finishes 2ms
     → expected [] to deeply equal [ 'agent', 'second', 'second' ]
   × AgentWorker lease heartbeat > does not rearm an acknowledged heartbeat after close begins 0ms
     → expected "spy" to be called 1 times, but got 0 times
stdout | tests/worker-heartbeat-live.test.ts > journals success after a real CLI runs beyond the 30-second lease
{"renewals":0,"errors":["JournalProtocolError: lease_conflict: attempt has no active worker lease","JournalProtocolError: lease_conflict: attempt has no active worker lease"]}

 ❯ tests/worker-heartbeat-live.test.ts (1 test | 1 failed) 64337ms
   × journals success after a real CLI runs beyond the 30-second lease 64336ms
     → expected [ …(2) ] to deeply equal []

⎯⎯⎯⎯⎯⎯ Failed Tests 10 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/worker-heartbeat-live.test.ts > journals success after a real CLI runs beyond the 30-second lease
AssertionError: expected [ …(2) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   [JournalProtocolError: lease_conflict: attempt has no active worker lease],
+   [JournalProtocolError: lease_conflict: attempt has no active worker lease],
+ ]

 ❯ tests/worker-heartbeat-live.test.ts:53:20
     51|     const terminal = journal.find(entry => entry.entry_type === 'run.c…
     52|     console.log(JSON.stringify({ renewals: heartbeat.mock.calls.length…
     53|     expect(errors).toEqual([]);
       |                    ^
     54|     expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
     55|     expect(completion).toHaveBeenCalledTimes(1);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > completes an agent step lasting 34000 simulated ms
 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > completes an agent step lasting 600000 simulated ms
AssertionError: expected [ Error: lease expired ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   [Error: lease expired],
+ ]

 ❯ tests/worker-heartbeat.test.ts:56:20
     54|     cli.resolve(result);
     55|     await worker.close();
     56|     expect(errors).toEqual([]);
       |                    ^
     57|     expect(client.stepHeartbeat.mock.calls.length).toBeGreaterThanOrEq…
     58|     expect(client.stepHeartbeat).toHaveBeenCalledWith('run', 'agent', …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > stops renewing when CLI execution throws
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ tests/worker-heartbeat.test.ts:86:34
     84|     await vi.advanceTimersByTimeAsync(0);
     85|     await vi.advanceTimersByTimeAsync(60_000);
     86|     expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
       |                                  ^
     87|     expect(errors).toEqual([new Error('CLI broke')]);
     88|     await worker.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > stops renewing at close even while the CLI is still running
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ tests/worker-heartbeat.test.ts:97:34
     95|     client.emit('step.dispatch', { ...dispatch, step_id: 'ignored' });
     96|     await vi.advanceTimersByTimeAsync(60_000);
     97|     expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
       |                                  ^
     98|     expect(runAgentCli).toHaveBeenCalledTimes(1);
     99|     cli.resolve(result);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > surfaces a renewal failure and still submits the CLI result
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ tests/worker-heartbeat.test.ts:109:34
    107|     cli.resolve(result);
    108|     await worker.close();
    109|     expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
       |                                  ^
    110|     expect(client.stepComplete).toHaveBeenCalledWith('run', 'agent', 1…
    111|       output: result, started_pins: dispatch.pins, end_pins: dispatch.…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > does not overlap renewals or complete before a pending renewal settles
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ tests/worker-heartbeat.test.ts:121:34
    119|     client.stepHeartbeat.mockReturnValue(renewal.promise);
    120|     await vi.advanceTimersByTimeAsync(20_000);
    121|     expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
       |                                  ^
    122|     cli.resolve(result);
    123|     await vi.advanceTimersByTimeAsync(0);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > retains renewal and completion errors together
AssertionError: expected Error: completion failed to be an instance of AggregateError
 ❯ tests/worker-heartbeat.test.ts:141:23
    139|     await worker.close();
    140|     expect(errors).toHaveLength(1);
    141|     expect(errors[0]).toBeInstanceOf(AggregateError);
       |                       ^
    142|     expect((errors[0] as AggregateError).errors).toEqual([
    143|       new Error('renewal failed'), new Error('completion failed'),

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > keeps another dispatch renewing when the first finishes
AssertionError: expected [] to deeply equal [ 'agent', 'second', 'second' ]

- Expected
+ Received

- Array [
-   "agent",
-   "second",
-   "second",
- ]
+ Array []

 ❯ tests/worker-heartbeat.test.ts:155:66
    153|     cli.resolve(result);
    154|     await vi.advanceTimersByTimeAsync(10_000);
    155|     expect(client.stepHeartbeat.mock.calls.map(call => call[1])).toEqu…
       |                                                                  ^
    156|     second.resolve(result);
    157|     await worker.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/10]⎯

 FAIL  tests/worker-heartbeat.test.ts > AgentWorker lease heartbeat > does not rearm an acknowledged heartbeat after close begins
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ tests/worker-heartbeat.test.ts:172:34
    170|     await closing;
    171|     await vi.advanceTimersByTimeAsync(60_000);
    172|     expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
       |                                  ^
    173|     expect(errors).toEqual([]);
    174|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/10]⎯

 Test Files  2 failed (2)
      Tests  10 failed | 2 passed (12)
   Start at  15:10:25
   Duration  64.64s (transform 90ms, setup 0ms, collect 167ms, tests 64.35s, environment 0ms, prepare 72ms)

```

Restoration check, from the repository root:
```sh
shasum -a 256 packages/sdk/src/worker.ts > /tmp/lease-renewal-0909-evidence/restore-after.txt
cmp /tmp/lease-renewal-0909-evidence/restore-before.txt /tmp/lease-renewal-0909-evidence/restore-after.txt && cat /tmp/lease-renewal-0909-evidence/restore-after.txt
```
Captured output (exit 0):
```text
12ab80765d29003f455e1cd66d054fa461366d7683c7fe7cf69c9e408f733ed9  packages/sdk/src/worker.ts
```

Re-run after restoring the fixed worker:
```sh
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3497393500/debug/relayflowd node node_modules/vitest/vitest.mjs run tests/worker-heartbeat.test.ts tests/worker-heartbeat-live.test.ts
```
Captured output (exit 0):
```text

 RUN  v2.1.9 /Users/khaliqgant/fl-lease/packages/sdk

 ✓ tests/worker-heartbeat.test.ts (11 tests) 11ms
stdout | tests/worker-heartbeat-live.test.ts > journals success after a real CLI runs beyond the 30-second lease
{"renewals":3,"terminal":{"at_ms":1788959546395,"attempt":null,"entry_type":"run.completed","payload":{"budget_total":{"dollars":"0","tokens_in":0,"tokens_out":0},"completionReason":"success","failed_step_id":null},"run_id":"01M234QNHS8CY6197Y4KNR0C0R","segment_id":1,"seq":5,"step_id":null},"errors":[]}

 ✓ tests/worker-heartbeat-live.test.ts (1 test) 34403ms
   ✓ journals success after a real CLI runs beyond the 30-second lease 34402ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  15:11:51
   Duration  34.65s (transform 76ms, setup 0ms, collect 135ms, tests 34.41s, environment 0ms, prepare 51ms)

```

## Build, type checks, and related regression tests

An explicit type check of the new fixtures initially found a missing dispatch
`lease_deadline_ms` and an unknown journal-entry type. Both fixture typings were
corrected; the SDK implementation stayed byte-for-byte as restored above.
The following captures the final commands, their output, and exit codes.
The live-kernel name filter deliberately selects eight tests; 22 are not run.
This is not a claim that the full SDK suite or RFC gates passed.

```text
$ node node_modules/typescript/bin/tsc
Exit code: 0

$ node node_modules/typescript/bin/tsc -p tsconfig.type-tests.json
Exit code: 0

$ node node_modules/typescript/bin/tsc -p tsconfig.tests.json
Exit code: 0

$ node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node,vitest tests/worker-heartbeat.test.ts tests/worker-heartbeat-live.test.ts
Exit code: 0

$ node node_modules/vitest/vitest.mjs run tests/worker-cli.test.ts tests/journal-client.test.ts tests/parse-json-output.test.ts tests/worker-heartbeat.test.ts

 RUN  v2.1.9 /Users/khaliqgant/fl-lease/packages/sdk

 ✓ tests/worker-heartbeat.test.ts (11 tests) 9ms
 ✓ tests/parse-json-output.test.ts (7 tests) 2ms
 ✓ tests/journal-client.test.ts (14 tests) 68ms
 ✓ tests/worker-cli.test.ts (13 tests) 19839ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a conforming wrapper leaks a stdio pipe to a background helper 1707ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when the leaked helper inherits stderr only 1724ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a wrapper leaks a stdio pipe and exits before identifying 3258ms
   ✓ custom wrapper execution bounds are reader-owned > journals a completionReason at the default bound when a wrapper leaks a stdio pipe 11257ms
   ✓ custom wrapper execution bounds are reader-owned > accepts the same over-8KiB payload whether or not it coalesces with the execute token 398ms

 Test Files  4 passed (4)
      Tests  45 passed (45)
   Start at  15:12:20
   Duration  20.04s (transform 150ms, setup 0ms, collect 253ms, tests 19.92s, environment 0ms, prepare 124ms)

Exit code: 0

$ RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3497393500/debug/relayflowd node node_modules/vitest/vitest.mjs run tests/live-kernel.test.ts -t 'AgentWorker|runs an agent CLI end to end'

 RUN  v2.1.9 /Users/khaliqgant/fl-lease/packages/sdk

stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/Users/khaliqgant/.relayflows-toolchain/target/3497393500/debug/relayflowd
LIVE_KERNEL flows=/Users/khaliqgant/fl-lease/packages/sdk/dist/cli.js

 ✓ tests/live-kernel.test.ts (30 tests | 22 skipped) 2589ms
   ✓ built flows CLI against live relayflowd > runs an agent CLI end to end through the SDK worker 319ms
   ✓ built flows CLI against live relayflowd > AgentWorker exposes wake_context to the CLI via RELAYFLOW_WAKE_CONTEXT env var (real analyzer prerequisite) 373ms
   ✓ built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_WAKE_CONTEXT UNSET when the run has no wake_context (undefined-vs-null pin) 332ms
   ✓ built flows CLI against live relayflowd > AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL 401ms
   ✓ built flows CLI against live relayflowd > AgentWorker refuses a nonconforming journal-submitted wrapper before exposing RELAYFLOW_MODEL 344ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw claude adapter with its real model flag 314ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw codex adapter with its real model flag 305ms

 Test Files  1 passed (1)
      Tests  8 passed | 22 skipped (30)
   Start at  15:12:40
   Duration  2.93s (transform 126ms, setup 0ms, collect 182ms, tests 2.59s, environment 0ms, prepare 26ms)

Exit code: 0

```

## Final heartbeat run with corrected fixture typings

```sh
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3497393500/debug/relayflowd node node_modules/vitest/vitest.mjs run tests/worker-heartbeat.test.ts tests/worker-heartbeat-live.test.ts
```
Captured output (exit 0):
```text

 RUN  v2.1.9 /Users/khaliqgant/fl-lease/packages/sdk

 ✓ tests/worker-heartbeat.test.ts (11 tests) 8ms
stdout | tests/worker-heartbeat-live.test.ts > journals success after a real CLI runs beyond the 30-second lease
{"renewals":3,"terminal":{"at_ms":1788959638591,"attempt":null,"entry_type":"run.completed","payload":{"budget_total":{"dollars":"0","tokens_in":0,"tokens_out":0},"completionReason":"success","failed_step_id":null},"run_id":"01M234TFFQ4YM5KD7JNDMHB2B5","segment_id":1,"seq":5,"step_id":null},"errors":[]}

 ✓ tests/worker-heartbeat-live.test.ts (1 test) 34535ms
   ✓ journals success after a real CLI runs beyond the 30-second lease 34534ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  15:13:23
   Duration  34.88s (transform 103ms, setup 0ms, collect 224ms, tests 34.54s, environment 0ms, prepare 92ms)

```
