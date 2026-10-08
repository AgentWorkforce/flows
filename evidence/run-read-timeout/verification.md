Captured verification at the review-fix source. Commands and output below are verbatim (absolute paths included): relayflowd is built from this tree by the kernel-build command, and both live suites run against that binary. [full-suite-final.log](full-suite-final.log) is the earlier full-suite transcript from before the review fixes (head a50a8de); it records that run's environment failures and does not cover the review-fix changes.

## kernel-build.log

```text
$ cd kernel && CARGO_TARGET_DIR=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.05s
exit=0
```

## final-focused.log

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target/debug/relayflowd npx vitest run tests/journal-client-read-timeout.test.ts tests/journal-client.test.ts tests/journal-client-completion.test.ts tests/journal-client-subscriptions.test.ts tests/running-step-watch.test.ts tests/heartbeat-timeout.test.ts tests/run-daemon-unresponsive.test.ts tests/authored-root.test.ts tests/classify-outcome.test.ts tests/cli.test.ts tests/direct-run-worker-lease.test.ts tests/resume-worker-lease.test.ts tests/worker-lease.test.ts tests/worker-lease-lost.test.ts tests/worker-lease-lost-live.test.ts tests/worker-lease-sweep.test.ts tests/run-read-load-live.test.ts tests/flow-executor-chain.test.ts tests/agent-transcript-live.test.ts tests/human-live.test.ts tests/reuse-summary-interruption.test.ts tests/memoization.test.ts --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/cli.test.ts (71 tests) 5258ms
   ✓ flows run/resume CLI over the journal protocol > follows a dispatched worker step instead of reporting a protocol error 2039ms
   ✓ flows run/resume CLI over the journal protocol > follows a worker wait past a locally expired lease until the daemon settles it 2036ms
(node:3253842) [FLOWS_ROOT_LEASE_LOST] Warning: authored root run_id=root-run attempt=1: lease_conflict: attempt has no active worker lease. Waiting for the kernel to retry it.
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/authored-root.test.ts (27 tests) 392ms
 ✓ tests/journal-client.test.ts (17 tests) 87ms
 ✓ tests/flow-executor-chain.test.ts (14 tests) 6781ms
   ✓ flow executor LLM and output-binding chain > runs f.llm -> f.agent -> f.run with schema-verified journal output and the exact allowed model 487ms
   ✓ flow executor LLM and output-binding chain > runs the exact authored flagship f.llm -> f.agent -> f.run path through the durable CLI root 1068ms
   ✓ flow executor LLM and output-binding chain > resumes an interrupted durable authored root without replaying completed flagship effects 2618ms
   ✓ flow executor LLM and output-binding chain > passes a declarative verified value through an agent into a deterministic artifact 338ms
   ✓ flow executor LLM and output-binding chain > flows run consumes YAML bindings and resume reuses the original journal output 738ms
 ✓ tests/agent-transcript-live.test.ts (4 tests) 2536ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured agent failure details and its completed root index 617ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured llm failure details and its completed root index 635ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > journals the digest in trajectory_tail on a successful agent step and writes the file it points at 633ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > on a failed agent step, names the failure and the transcript in the terminal diagnostic, redacted 650ms
 ✓ tests/classify-outcome.test.ts (11 tests) 7428ms
   ✓ classifyOutcome > gives up and reports when a running run never becomes classifiable 2013ms
   ✓ the remedy on a worker park > follows a step through a retry backoff longer than the unclassified bound 3007ms
   ✓ the remedy on a worker park > follows a run.start outcome that is already running on a retried attempt 2002ms
 ✓ tests/journal-client-read-timeout.test.ts (17 tests) 1407ms
 ✓ tests/human-live.test.ts (3 tests) 5520ms
   ✓ f.human against a real daemon > parks with the question, refuses wrong answers, records one, and resumes to success 3662ms
   ✓ f.human against a real daemon > a "no" is a value the body branches on: declined, exit 0, no effect 1130ms
   ✓ f.human against a real daemon > refuses to answer a run the daemon does not know 728ms
 ✓ tests/running-step-watch.test.ts (6 tests) 6235ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2118ms
   ✓ cancels promptly while a lease snapshot read is in flight 2006ms
   ✓ a completion push ends the wait without waiting out an in-flight snapshot 2054ms
 ✓ tests/worker-lease.test.ts (7 tests) 21ms
 ✓ tests/worker-lease-lost.test.ts (17 tests) 26ms
 ✓ tests/worker-lease-lost-live.test.ts (3 tests) 654ms
 ✓ tests/run-read-load-live.test.ts (2 tests) 2496ms
   ✓ completes a CPU-saturating deterministic flow with reads in flight and preserves its journal 2053ms
   ✓ drains read and watch promises before an authored flow completes 442ms
 ✓ tests/worker-lease-sweep.test.ts (4 tests) 6ms
 ✓ tests/journal-client-completion.test.ts (6 tests) 105ms
 ✓ tests/resume-worker-lease.test.ts (3 tests) 7ms
 ✓ tests/direct-run-worker-lease.test.ts (3 tests) 9ms
 ✓ tests/memoization.test.ts (57 tests) 55ms
 ✓ tests/journal-client-subscriptions.test.ts (1 test) 7ms
 ✓ tests/run-daemon-unresponsive.test.ts (3 tests) 4ms
 ✓ tests/reuse-summary-interruption.test.ts (3 tests) 4ms
 ✓ tests/heartbeat-timeout.test.ts (1 test) 15ms

 Test Files  22 passed (22)
      Tests  280 passed (280)
   Start at  00:54:04
   Duration  47.77s (transform 1.05s, setup 123ms, collect 5.93s, tests 39.05s, environment 3ms, prepare 786ms)

exit=0
```

## resume-live.log

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target/debug/relayflowd npx vitest run tests/read-timeout-resume-live.test.ts

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/read-timeout-resume-live.test.ts (1 test) 942ms
   ✓ parks an unreadable authored root and resumes without repeating its journaled effect 942ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:54:52
   Duration  2.21s (transform 624ms, setup 19ms, collect 1.02s, tests 942ms, environment 0ms, prepare 82ms)

exit=0
```

The mutation sections below were regenerated by `python3 evidence/run-read-timeout/mutations.py` (run from `packages/sdk`) against the review-fix source; each mutation fails its test and the restored source passes.

## mutation-reader.log

```text
Source: packages/sdk/src/journal-client.ts
Original SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
Replaced:
return await reader.requestOnce(verb, params, remaining, attemptSignal);
With:
return await this.requestOnce(verb, params, remaining, attemptSignal);

REVERTED
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'serves a bounded read' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/journal-client-read-timeout.test.ts (17 tests | 1 failed | 16 skipped) 115ms
   × serves a bounded read while an unbounded command is in flight 114ms
     → expected true to be false // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > serves a bounded read while an unbounded command is in flight
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ tests/journal-client-read-timeout.test.ts:37:23
     35|   await inFlight;
     36|   expect(await client.runGet('run')).toMatchObject({ status: 'running'…
     37|   expect(commandDone).toBe(false);
       |                       ^
     38|   await command;
     39| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 16 skipped (17)
   Start at  00:53:30
   Duration  610ms (transform 180ms, setup 19ms, collect 302ms, tests 115ms, environment 0ms, prepare 50ms)

exit=1

RESTORED SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'serves a bounded read' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (17 tests | 16 skipped) 106ms

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  00:53:31
   Duration  529ms (transform 161ms, setup 13ms, collect 262ms, tests 106ms, environment 0ms, prepare 43ms)

exit=0
```

## mutation-reader-reconnect.log

```text
Source: packages/sdk/src/journal-client.ts
Original SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
Replaced:
          this.dropReader(reader);

With:


REVERTED
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'reconnects the reader after it disconnects' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/journal-client-read-timeout.test.ts (17 tests | 1 failed | 16 skipped) 1008ms
   × reconnects the reader after it disconnects within the read budget 1007ms
     → journal client: run.get read session was interrupted after 80 attempts in 1000ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > reconnects the reader after it disconnects within the read budget
JournalReadInterruptedError: journal client: run.get read session was interrupted after 80 attempts in 1000ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed
 ❯ exhausted src/journal-read-policy.ts:70:9
     68|     let last: unknown;
     69|     const exhausted = () => last instanceof JournalReadInterruptedError
     70|       ? new JournalReadInterruptedError(verb, attempts, performance.no…
       |         ^
     71|       : new JournalRequestTimeoutError(verb, timeoutMs, attempts, perf…
     72|     // A caller's cancellation settles this read and drains its queued…
 ❯ Timeout.<anonymous> src/journal-read-policy.ts:81:39

Caused by: Error: journal client: not connected (run.get): journal client: connection closed
 ❯ src/journal-client.ts:270:16
 ❯ JournalClient.requestOnce src/journal-client.ts:263:12
 ❯ src/journal-client.ts:245:31
 ❯ src/journal-read-policy.ts:93:18

Caused by: Error: journal client: connection closed
 ❯ Socket.<anonymous> src/journal-client.ts:125:26

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 16 skipped (17)
   Start at  00:53:32
   Duration  1.46s (transform 166ms, setup 18ms, collect 286ms, tests 1.01s, environment 0ms, prepare 42ms)

exit=1

RESTORED SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'reconnects the reader after it disconnects' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (17 tests | 16 skipped) 78ms

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  00:53:34
   Duration  522ms (transform 156ms, setup 16ms, collect 276ms, tests 78ms, environment 0ms, prepare 43ms)

exit=0
```

## mutation-reader-setup-retry.log

```text
Source: packages/sdk/src/journal-client.ts
Original SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
Replaced:
          if (this.reader === reader) {
            this.reader = undefined;
            this.readerReady = undefined;
          }
          throw error;

With:
          return undefined;


REVERTED
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'retries a reader setup that timed out' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/journal-client-read-timeout.test.ts (17 tests | 1 failed | 16 skipped) 73ms
   × retries a reader setup that timed out instead of reading on the primary for good 72ms
     → expected 1 to be 2 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > retries a reader setup that timed out instead of reading on the primary for good
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ tests/journal-client-read-timeout.test.ts:202:18
    200|   expect(await client.runGet('run')).toMatchObject({ status: 'complete…
    201|   expect(await client.runGet('run')).toMatchObject({ status: 'complete…
    202|   expect(hellos).toBe(2);
       |                  ^
    203|   expect(served).toHaveLength(2);
    204|   expect(served.every(socket => socket !== primary)).toBe(true);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 16 skipped (17)
   Start at  00:53:35
   Duration  523ms (transform 166ms, setup 18ms, collect 281ms, tests 73ms, environment 0ms, prepare 46ms)

exit=1

RESTORED SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'retries a reader setup that timed out' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (17 tests | 16 skipped) 67ms

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  00:53:36
   Duration  520ms (transform 167ms, setup 17ms, collect 290ms, tests 67ms, environment 0ms, prepare 44ms)

exit=0
```

## mutation-watch-cadence.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: b84dc4f0d83e3f8c31d55a38f42a0d68c25299970d05ec7f3be772290f8d1a6e
Replaced:
const LEASE_POLL_MS = 2_000;
With:
const LEASE_POLL_MS = 50;

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (6 tests | 1 failed | 5 skipped) 2111ms
   × uses pushes for completion with lease-cadence reads and releases its watcher 2110ms
     → expected 41 to be less than or equal to 1

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/running-step-watch.test.ts > uses pushes for completion with lease-cadence reads and releases its watcher
AssertionError: expected 41 to be less than or equal to 1
 ❯ tests/running-step-watch.test.ts:39:19
     37|     await waitForRunningStep(client, 'run', { id: 'step', type: 'agent…
     38|     expect(performance.now() - start).toBeGreaterThan(2000);
     39|     expect(reads).toBeLessThanOrEqual(1);
       |                   ^
     40|     await sleep(10);
     41|     expect(watchClosed).toBe(true);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
   Start at  00:53:37
   Duration  2.59s (transform 186ms, setup 17ms, collect 316ms, tests 2.11s, environment 0ms, prepare 43ms)

exit=1

RESTORED SHA256: b84dc4f0d83e3f8c31d55a38f42a0d68c25299970d05ec7f3be772290f8d1a6e
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (6 tests | 5 skipped) 2118ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2117ms

 Test Files  1 passed (1)
      Tests  1 passed | 5 skipped (6)
   Start at  00:53:40
   Duration  2.59s (transform 187ms, setup 16ms, collect 316ms, tests 2.12s, environment 0ms, prepare 40ms)

exit=0
```

## mutation-snapshot-cancel.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: b84dc4f0d83e3f8c31d55a38f42a0d68c25299970d05ec7f3be772290f8d1a6e
Replaced:
const signal = options.signal === undefined ? snapshotRead.signal
        : AbortSignal.any([options.signal, snapshotRead.signal]);
With:
const signal = snapshotRead.signal;

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (6 tests | 1 failed | 5 skipped) 2215ms
   × cancels promptly while a lease snapshot read is in flight 2215ms
     → expected 'still waiting' to be an instance of Error

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/running-step-watch.test.ts > cancels promptly while a lease snapshot read is in flight
AssertionError: expected 'still waiting' to be an instance of Error
 ❯ tests/running-step-watch.test.ts:83:21
     81|     controller.abort();
     82|     const settled = await Promise.race([outcome, sleep(200).then(() =>…
     83|     expect(settled).toBeInstanceOf(Error);
       |                     ^
     84|     expect((settled as Error).message).toContain('was canceled');
     85|   } finally { client.close(); await new Promise<void>(resolve => serve…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
   Start at  00:53:43
   Duration  2.68s (transform 182ms, setup 17ms, collect 307ms, tests 2.22s, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: b84dc4f0d83e3f8c31d55a38f42a0d68c25299970d05ec7f3be772290f8d1a6e
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (6 tests | 5 skipped) 2011ms
   ✓ cancels promptly while a lease snapshot read is in flight 2010ms

 Test Files  1 passed (1)
      Tests  1 passed | 5 skipped (6)
   Start at  00:53:46
   Duration  2.48s (transform 183ms, setup 16ms, collect 311ms, tests 2.01s, environment 0ms, prepare 41ms)

exit=0
```

## mutation-completion-aborts-snapshot.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: b84dc4f0d83e3f8c31d55a38f42a0d68c25299970d05ec7f3be772290f8d1a6e
Replaced:
snapshotRead?.abort(new Error(`step "${runningStep.id}" completed during the lease snapshot`));
With:


REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'a completion push ends the wait' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (6 tests | 1 failed | 5 skipped) 3013ms
   × a completion push ends the wait without waiting out an in-flight snapshot 3012ms
     → expected 'still waiting' to be 'returned' // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/running-step-watch.test.ts > a completion push ends the wait without waiting out an in-flight snapshot
AssertionError: expected 'still waiting' to be 'returned' // Object.is equality

Expected: "returned"
Received: "still waiting"

 ❯ tests/running-step-watch.test.ts:152:21
    150|     const waiting = waitForRunningStep(client, 'run', { id: 'step', ty…
    151|     const outcome = await Promise.race([waiting.then(() => 'returned')…
    152|     expect(outcome).toBe('returned');
       |                     ^
    153|     expect(await client.runGet('run', { signal: AbortSignal.timeout(50…
    154|   } finally { client.close(); await new Promise<void>(resolve => serve…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
   Start at  00:53:49
   Duration  3.49s (transform 191ms, setup 16ms, collect 320ms, tests 3.01s, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: b84dc4f0d83e3f8c31d55a38f42a0d68c25299970d05ec7f3be772290f8d1a6e
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'a completion push ends the wait' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (6 tests | 5 skipped) 2062ms
   ✓ a completion push ends the wait without waiting out an in-flight snapshot 2061ms

 Test Files  1 passed (1)
      Tests  1 passed | 5 skipped (6)
   Start at  00:53:52
   Duration  2.50s (transform 182ms, setup 16ms, collect 305ms, tests 2.06s, environment 0ms, prepare 29ms)

exit=0
```

## mutation-heartbeat.log

```text
Source: packages/sdk/src/worker-lease.ts
Original SHA256: 44c13f9f61ac13cb8c0f872f4c22b1c212e020d05880ed080ea7205ba6007213
Replaced:
      if (error instanceof JournalRequestTimeoutError && error.verb === 'step.heartbeat') {
        throw new WorkerLeaseLostError('renewal_expired', error.message, { cause: error });
      }

With:


REVERTED
$ cd packages/sdk && npx vitest run tests/heartbeat-timeout.test.ts -t 'a heartbeat timeout' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/heartbeat-timeout.test.ts (1 test | 1 failed) 18ms
   × a heartbeat timeout is lease loss rather than a worker body failure 18ms
     → expected JournalRequestTimeoutError: journal clien… { …(5) } to be an instance of WorkerLeaseLostError

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/heartbeat-timeout.test.ts > a heartbeat timeout is lease loss rather than a worker body failure
AssertionError: expected JournalRequestTimeoutError: journal clien… { …(5) } to be an instance of WorkerLeaseLostError
 ❯ tests/heartbeat-timeout.test.ts:16:5
     14|   try {
     15|     await client.connect();
     16|     await expect(withWorkerLease(client, {
       |     ^
     17|       run_id: 'run', step_id: 'step', attempt: 1, step_type: 'agent', …
     18|       lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000, lease…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  00:53:55
   Duration  453ms (transform 168ms, setup 18ms, collect 273ms, tests 18ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 44c13f9f61ac13cb8c0f872f4c22b1c212e020d05880ed080ea7205ba6007213
$ cd packages/sdk && npx vitest run tests/heartbeat-timeout.test.ts -t 'a heartbeat timeout' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/heartbeat-timeout.test.ts (1 test) 15ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:53:56
   Duration  453ms (transform 165ms, setup 17ms, collect 278ms, tests 15ms, environment 0ms, prepare 41ms)

exit=0
```

## mutation-root-parking.log

```text
Source: packages/sdk/src/authored-root.ts
Original SHA256: 999d3eca1236966ca84d0c4a07694a7449bf0a35dd1e7fac455ab0f510804f1a
Replaced:
    if (isReadInterruptionError(error)
      || (error instanceof AuthoredFlowExecutionError && error.code === 'daemon_unresponsive')) {
      const parked = new AuthoredFlowExecutionError('daemon_unresponsive',
        `${error.message}. The run remains resumable. Continue with: ${resumeCommand(dispatch.run_id, options.dataDir, options.localAgentStream !== undefined)}.`);
      parked.rootRunId = dispatch.run_id;
      throw parked;
    }

With:


REVERTED
$ cd packages/sdk && npx vitest run tests/authored-root.test.ts -t 'leaves the root resumable' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/authored-root.test.ts (27 tests | 3 failed | 24 skipped) 30ms
   × durable authored root > leaves the root resumable after a read timeout without waiting for redispatch (Node frame=false) 21ms
     → expected JournalRequestTimeoutError: journal clien… { …(5) } to match object { code: 'daemon_unresponsive', …(2) }
(6 matching properties omitted from actual)
   × durable authored root > leaves the root resumable after a read timeout without waiting for redispatch (Node frame=true) 4ms
     → expected AuthoredFlowExecutionError: daemon_unresp… { …(7) } to match object { code: 'daemon_unresponsive', …(2) }
(6 matching properties omitted from actual)
   × durable authored root > leaves the root resumable when the read session disconnects while the root worker is healthy 4ms
     → expected JournalReadInterruptedError: journal clie… { …(4) } to match object { code: 'daemon_unresponsive', …(2) }
(5 matching properties omitted from actual)

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/authored-root.test.ts > durable authored root > leaves the root resumable after a read timeout without waiting for redispatch (Node frame=false)
AssertionError: expected JournalRequestTimeoutError: journal clien… { …(5) } to match object { code: 'daemon_unresponsive', …(2) }
(6 matching properties omitted from actual)

- Expected
+ Received

- Object {
-   "code": "daemon_unresponsive",
-   "message": StringContaining "flows resume",
-   "rootRunId": "root-run",
- }
+ [JournalRequestTimeoutError: journal client: run.get timed out after 10ms]

 ❯ tests/authored-root.test.ts:415:5
    413|     });
    414|     const journal = new RootJournal();
    415|     await expect(executeDurableAuthoredFlow(loaded, journal as unknown…
       |     ^
    416|       { dataDir: '/unused', admissionKey: 'read-timeout' })).rejects.t…
    417|         code: 'daemon_unresponsive', rootRunId: 'root-run', message: e…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  tests/authored-root.test.ts > durable authored root > leaves the root resumable after a read timeout without waiting for redispatch (Node frame=true)
AssertionError: expected AuthoredFlowExecutionError: daemon_unresp… { …(7) } to match object { code: 'daemon_unresponsive', …(2) }
(6 matching properties omitted from actual)

- Expected
+ Received

- Object {
+ AuthoredFlowExecutionError {
    "code": "daemon_unresponsive",
-   "message": StringContaining "flows resume",
    "rootRunId": "root-run",
  }

 ❯ tests/authored-root.test.ts:415:5
    413|     });
    414|     const journal = new RootJournal();
    415|     await expect(executeDurableAuthoredFlow(loaded, journal as unknown…
       |     ^
    416|       { dataDir: '/unused', admissionKey: 'read-timeout' })).rejects.t…
    417|         code: 'daemon_unresponsive', rootRunId: 'root-run', message: e…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  tests/authored-root.test.ts > durable authored root > leaves the root resumable when the read session disconnects while the root worker is healthy
AssertionError: expected JournalReadInterruptedError: journal clie… { …(4) } to match object { code: 'daemon_unresponsive', …(2) }
(5 matching properties omitted from actual)

- Expected
+ Received

- Object {
-   "code": "daemon_unresponsive",
-   "message": StringContaining "flows resume",
-   "rootRunId": "root-run",
- }
+ [JournalReadInterruptedError: journal client: run.get read session was interrupted after 2 attempts in 40ms (read budget 300000ms): journal client: connection closed]

 ❯ tests/authored-root.test.ts:428:5
    426|     const loaded = await fixture(false, 0, async () => { throw interru…
    427|     const journal = new RootJournal();
    428|     await expect(executeDurableAuthoredFlow(loaded, journal as unknown…
       |     ^
    429|       { dataDir: '/unused', admissionKey: 'read-disconnect' })).reject…
    430|         code: 'daemon_unresponsive', rootRunId: 'root-run', message: e…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯

 Test Files  1 failed (1)
      Tests  3 failed | 24 skipped (27)
   Start at  00:53:57
   Duration  1.24s (transform 648ms, setup 16ms, collect 1.06s, tests 30ms, environment 0ms, prepare 28ms)

exit=1

RESTORED SHA256: 999d3eca1236966ca84d0c4a07694a7449bf0a35dd1e7fac455ab0f510804f1a
$ cd packages/sdk && npx vitest run tests/authored-root.test.ts -t 'leaves the root resumable' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/authored-root.test.ts (27 tests | 24 skipped) 23ms

 Test Files  1 passed (1)
      Tests  3 passed | 24 skipped (27)
   Start at  00:53:59
   Duration  1.22s (transform 650ms, setup 16ms, collect 1.04s, tests 23ms, environment 0ms, prepare 41ms)

exit=0
```
