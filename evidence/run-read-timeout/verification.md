Captured verification at the review-fix source. Commands and output below are verbatim (absolute paths included): relayflowd is built from this tree by the kernel-build command, and both live suites run against that binary. [full-suite-final.log](full-suite-final.log) is the earlier full-suite transcript from before the review fixes (head a50a8de); it records that run's environment failures and does not cover the review-fix changes.

## kernel-build.log

```text
$ cd kernel && CARGO_TARGET_DIR=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.04s
exit=0
```

## final-focused.log

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target/debug/relayflowd npx vitest run tests/journal-client-read-timeout.test.ts tests/journal-client.test.ts tests/journal-client-completion.test.ts tests/journal-client-subscriptions.test.ts tests/running-step-watch.test.ts tests/heartbeat-timeout.test.ts tests/run-daemon-unresponsive.test.ts tests/authored-root.test.ts tests/classify-outcome.test.ts tests/cli.test.ts tests/direct-run-worker-lease.test.ts tests/resume-worker-lease.test.ts tests/worker-lease.test.ts tests/worker-lease-lost.test.ts tests/worker-lease-lost-live.test.ts tests/worker-lease-sweep.test.ts tests/run-read-load-live.test.ts tests/flow-executor-chain.test.ts tests/agent-transcript-live.test.ts tests/human-live.test.ts tests/reuse-summary-interruption.test.ts tests/memoization.test.ts tests/authored-verifier-read-budget.test.ts --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/cli.test.ts (71 tests) 5255ms
   ✓ flows check CLI > resolves a bare PATH-resolved claude with no declared model, in an isolated PATH 322ms
   ✓ flows run/resume CLI over the journal protocol > follows a dispatched worker step instead of reporting a protocol error 2039ms
   ✓ flows run/resume CLI over the journal protocol > follows a worker wait past a locally expired lease until the daemon settles it 2033ms
(node:3512367) [FLOWS_ROOT_LEASE_LOST] Warning: authored root run_id=root-run attempt=1: lease_conflict: attempt has no active worker lease. Waiting for the kernel to retry it.
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/authored-root.test.ts (27 tests) 390ms
 ✓ tests/journal-client.test.ts (17 tests) 80ms
 ✓ tests/flow-executor-chain.test.ts (14 tests) 6940ms
   ✓ flow executor LLM and output-binding chain > runs f.llm -> f.agent -> f.run with schema-verified journal output and the exact allowed model 468ms
   ✓ flow executor LLM and output-binding chain > runs the exact authored flagship f.llm -> f.agent -> f.run path through the durable CLI root 1067ms
   ✓ flow executor LLM and output-binding chain > resumes an interrupted durable authored root without replaying completed flagship effects 2741ms
   ✓ flow executor LLM and output-binding chain > passes a declarative verified value through an agent into a deterministic artifact 349ms
   ✓ flow executor LLM and output-binding chain > flows run consumes YAML bindings and resume reuses the original journal output 827ms
 ✓ tests/agent-transcript-live.test.ts (4 tests) 2544ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured agent failure details and its completed root index 651ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured llm failure details and its completed root index 595ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > journals the digest in trajectory_tail on a successful agent step and writes the file it points at 624ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > on a failed agent step, names the failure and the transcript in the terminal diagnostic, redacted 673ms
 ✓ tests/journal-client-read-timeout.test.ts (20 tests) 1427ms
 ✓ tests/classify-outcome.test.ts (11 tests) 7425ms
   ✓ classifyOutcome > gives up and reports when a running run never becomes classifiable 2011ms
   ✓ the remedy on a worker park > follows a step through a retry backoff longer than the unclassified bound 3006ms
   ✓ the remedy on a worker park > follows a run.start outcome that is already running on a retried attempt 2001ms
 ✓ tests/human-live.test.ts (3 tests) 4580ms
   ✓ f.human against a real daemon > parks with the question, refuses wrong answers, records one, and resumes to success 2734ms
   ✓ f.human against a real daemon > a "no" is a value the body branches on: declined, exit 0, no effect 1166ms
   ✓ f.human against a real daemon > refuses to answer a run the daemon does not know 679ms
 ✓ tests/running-step-watch.test.ts (7 tests) 8236ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2116ms
   ✓ cancels promptly while a lease snapshot read is in flight 2006ms
   ✓ a completion push ends the wait without waiting out an in-flight snapshot 2055ms
   ✓ a completion that aborts the snapshot is not an error even if a retry starts at once 2003ms
 ✓ tests/worker-lease.test.ts (7 tests) 20ms
 ✓ tests/worker-lease-lost.test.ts (17 tests) 26ms
 ✓ tests/worker-lease-lost-live.test.ts (3 tests) 697ms
 ✓ tests/memoization.test.ts (58 tests) 64ms
 ✓ tests/run-read-load-live.test.ts (2 tests) 2471ms
   ✓ completes a CPU-saturating deterministic flow with reads in flight and preserves its journal 2057ms
   ✓ drains read and watch promises before an authored flow completes 414ms
 ✓ tests/worker-lease-sweep.test.ts (4 tests) 8ms
 ✓ tests/journal-client-completion.test.ts (6 tests) 102ms
 ✓ tests/resume-worker-lease.test.ts (3 tests) 7ms
 ✓ tests/direct-run-worker-lease.test.ts (3 tests) 9ms
 ✓ tests/reuse-summary-interruption.test.ts (5 tests) 4ms
 ✓ tests/journal-client-subscriptions.test.ts (1 test) 7ms
 ✓ tests/run-daemon-unresponsive.test.ts (3 tests) 4ms
 ✓ tests/authored-verifier-read-budget.test.ts (2 tests) 49ms
 ✓ tests/heartbeat-timeout.test.ts (1 test) 15ms

 Test Files  23 passed (23)
      Tests  289 passed (289)
   Start at  01:34:37
   Duration  48.85s (transform 1.05s, setup 122ms, collect 5.61s, tests 40.36s, environment 3ms, prepare 812ms)

exit=0
```

## resume-live.log

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target/debug/relayflowd npx vitest run tests/read-timeout-resume-live.test.ts

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/read-timeout-resume-live.test.ts (1 test) 931ms
   ✓ parks an unreadable authored root and resumes without repeating its journaled effect 930ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  01:35:26
   Duration  2.18s (transform 616ms, setup 20ms, collect 1.01s, tests 931ms, environment 0ms, prepare 80ms)

exit=0
```

The mutation sections below were regenerated by `python3 evidence/run-read-timeout/mutations.py` (run from `packages/sdk`) against the review-fix source; each mutation fails its test and the restored source passes.

## mutation-reader.log

```text
Source: packages/sdk/src/journal-client.ts
Original SHA256: 9c77a946018fecb31ee86b19e343b78cb65f077e87bd03395b5dcb30f2e3a0a3
Replaced:
return await reader.requestOnce(verb, params, remaining, attemptSignal);
With:
return await this.requestOnce(verb, params, remaining, attemptSignal);

REVERTED
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'serves a bounded read' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/journal-client-read-timeout.test.ts (20 tests | 1 failed | 19 skipped) 114ms
   × serves a bounded read while an unbounded command is in flight 113ms
     → expected true to be false // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > serves a bounded read while an unbounded command is in flight
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ tests/journal-client-read-timeout.test.ts:38:23
     36|   await inFlight;
     37|   expect(await client.runGet('run')).toMatchObject({ status: 'running'…
     38|   expect(commandDone).toBe(false);
       |                       ^
     39|   await command;
     40| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 19 skipped (20)
   Start at  01:34:04
   Duration  542ms (transform 158ms, setup 17ms, collect 274ms, tests 114ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 9c77a946018fecb31ee86b19e343b78cb65f077e87bd03395b5dcb30f2e3a0a3
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'serves a bounded read' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (20 tests | 19 skipped) 106ms

 Test Files  1 passed (1)
      Tests  1 passed | 19 skipped (20)
   Start at  01:34:05
   Duration  544ms (transform 163ms, setup 16ms, collect 281ms, tests 106ms, environment 0ms, prepare 41ms)

exit=0
```

## mutation-reader-reconnect.log

```text
Source: packages/sdk/src/journal-client.ts
Original SHA256: 9c77a946018fecb31ee86b19e343b78cb65f077e87bd03395b5dcb30f2e3a0a3
Replaced:
          this.dropReader(reader);

With:


REVERTED
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'reconnects the reader after it disconnects' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/journal-client-read-timeout.test.ts (20 tests | 1 failed | 19 skipped) 1009ms
   × reconnects the reader after it disconnects within the read budget 1009ms
     → journal client: run.get read session was interrupted after 79 attempts in 1000ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > reconnects the reader after it disconnects within the read budget
JournalReadInterruptedError: journal client: run.get read session was interrupted after 79 attempts in 1000ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed
 ❯ exhausted src/journal-read-policy.ts:70:9
     68|     let last: unknown;
     69|     const exhausted = () => last instanceof JournalReadInterruptedError
     70|       ? new JournalReadInterruptedError(verb, attempts, performance.no…
       |         ^
     71|       : new JournalRequestTimeoutError(verb, timeoutMs, attempts, perf…
     72|     // A caller's cancellation settles this read and drains its queued…
 ❯ Timeout.<anonymous> src/journal-read-policy.ts:81:39

Caused by: Error: journal client: not connected (run.get): journal client: connection closed
 ❯ src/journal-client.ts:285:16
 ❯ JournalClient.requestOnce src/journal-client.ts:278:12
 ❯ src/journal-client.ts:259:31
 ❯ src/journal-read-policy.ts:93:18

Caused by: Error: journal client: connection closed
 ❯ Socket.<anonymous> src/journal-client.ts:137:26

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 19 skipped (20)
   Start at  01:34:06
   Duration  1.45s (transform 166ms, setup 18ms, collect 283ms, tests 1.01s, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 9c77a946018fecb31ee86b19e343b78cb65f077e87bd03395b5dcb30f2e3a0a3
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'reconnects the reader after it disconnects' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (20 tests | 19 skipped) 93ms

 Test Files  1 passed (1)
      Tests  1 passed | 19 skipped (20)
   Start at  01:34:07
   Duration  535ms (transform 165ms, setup 16ms, collect 282ms, tests 93ms, environment 0ms, prepare 40ms)

exit=0
```

## mutation-reader-setup-retry.log

```text
Source: packages/sdk/src/journal-client.ts
Original SHA256: 9c77a946018fecb31ee86b19e343b78cb65f077e87bd03395b5dcb30f2e3a0a3
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

 ❯ tests/journal-client-read-timeout.test.ts (20 tests | 1 failed | 19 skipped) 77ms
   × retries a reader setup that timed out instead of reading on the primary for good 76ms
     → expected 1 to be 2 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > retries a reader setup that timed out instead of reading on the primary for good
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ tests/journal-client-read-timeout.test.ts:203:18
    201|   expect(await client.runGet('run')).toMatchObject({ status: 'complete…
    202|   expect(await client.runGet('run')).toMatchObject({ status: 'complete…
    203|   expect(hellos).toBe(2);
       |                  ^
    204|   expect(served).toHaveLength(2);
    205|   expect(served.every(socket => socket !== primary)).toBe(true);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 19 skipped (20)
   Start at  01:34:08
   Duration  520ms (transform 162ms, setup 17ms, collect 280ms, tests 77ms, environment 0ms, prepare 40ms)

exit=1

RESTORED SHA256: 9c77a946018fecb31ee86b19e343b78cb65f077e87bd03395b5dcb30f2e3a0a3
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'retries a reader setup that timed out' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (20 tests | 19 skipped) 74ms

 Test Files  1 passed (1)
      Tests  1 passed | 19 skipped (20)
   Start at  01:34:09
   Duration  523ms (transform 170ms, setup 17ms, collect 297ms, tests 74ms, environment 0ms, prepare 41ms)

exit=0
```

## mutation-watch-cadence.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: 5f7ca7c0a29e5dcd0be4650369e994a21aa715f7dbdc45363924abf5df30d96b
Replaced:
const LEASE_POLL_MS = 2_000;
With:
const LEASE_POLL_MS = 50;

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (7 tests | 1 failed | 6 skipped) 2111ms
   × uses pushes for completion with lease-cadence reads and releases its watcher 2111ms
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
      Tests  1 failed | 6 skipped (7)
   Start at  01:34:10
   Duration  2.59s (transform 182ms, setup 17ms, collect 311ms, tests 2.11s, environment 0ms, prepare 42ms)

exit=1

RESTORED SHA256: 5f7ca7c0a29e5dcd0be4650369e994a21aa715f7dbdc45363924abf5df30d96b
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (7 tests | 6 skipped) 2118ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2118ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  01:34:13
   Duration  2.58s (transform 184ms, setup 16ms, collect 313ms, tests 2.12s, environment 0ms, prepare 40ms)

exit=0
```

## mutation-snapshot-cancel.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: 5f7ca7c0a29e5dcd0be4650369e994a21aa715f7dbdc45363924abf5df30d96b
Replaced:
const signal = options.signal === undefined ? read.signal
        : AbortSignal.any([options.signal, read.signal]);
With:
const signal = read.signal;

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (7 tests | 1 failed | 6 skipped) 2217ms
   × cancels promptly while a lease snapshot read is in flight 2216ms
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
      Tests  1 failed | 6 skipped (7)
   Start at  01:34:16
   Duration  2.70s (transform 191ms, setup 16ms, collect 321ms, tests 2.22s, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 5f7ca7c0a29e5dcd0be4650369e994a21aa715f7dbdc45363924abf5df30d96b
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (7 tests | 6 skipped) 2011ms
   ✓ cancels promptly while a lease snapshot read is in flight 2010ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  01:34:19
   Duration  2.46s (transform 178ms, setup 17ms, collect 300ms, tests 2.01s, environment 0ms, prepare 41ms)

exit=0
```

## mutation-completion-aborts-snapshot.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: 5f7ca7c0a29e5dcd0be4650369e994a21aa715f7dbdc45363924abf5df30d96b
Replaced:
snapshotRead?.abort(new Error(`step "${runningStep.id}" completed during the lease snapshot`));
With:


REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'a completion push ends the wait' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (7 tests | 1 failed | 6 skipped) 3012ms
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
      Tests  1 failed | 6 skipped (7)
   Start at  01:34:22
   Duration  3.48s (transform 186ms, setup 17ms, collect 313ms, tests 3.01s, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 5f7ca7c0a29e5dcd0be4650369e994a21aa715f7dbdc45363924abf5df30d96b
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'a completion push ends the wait' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (7 tests | 6 skipped) 2061ms
   ✓ a completion push ends the wait without waiting out an in-flight snapshot 2061ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  01:34:26
   Duration  2.52s (transform 183ms, setup 17ms, collect 312ms, tests 2.06s, environment 0ms, prepare 40ms)

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

 ❯ tests/heartbeat-timeout.test.ts (1 test | 1 failed) 19ms
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
   Start at  01:34:28
   Duration  465ms (transform 168ms, setup 15ms, collect 287ms, tests 19ms, environment 0ms, prepare 40ms)

exit=1

RESTORED SHA256: 44c13f9f61ac13cb8c0f872f4c22b1c212e020d05880ed080ea7205ba6007213
$ cd packages/sdk && npx vitest run tests/heartbeat-timeout.test.ts -t 'a heartbeat timeout' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/heartbeat-timeout.test.ts (1 test) 13ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  01:34:29
   Duration  431ms (transform 160ms, setup 17ms, collect 261ms, tests 13ms, environment 0ms, prepare 40ms)

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

 ❯ tests/authored-root.test.ts (27 tests | 3 failed | 24 skipped) 31ms
   × durable authored root > leaves the root resumable after a read timeout without waiting for redispatch (Node frame=false) 22ms
     → expected JournalRequestTimeoutError: journal clien… { …(5) } to match object { code: 'daemon_unresponsive', …(2) }
(6 matching properties omitted from actual)
   × durable authored root > leaves the root resumable after a read timeout without waiting for redispatch (Node frame=true) 5ms
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
   Start at  01:34:30
   Duration  1.29s (transform 670ms, setup 16ms, collect 1.10s, tests 31ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 999d3eca1236966ca84d0c4a07694a7449bf0a35dd1e7fac455ab0f510804f1a
$ cd packages/sdk && npx vitest run tests/authored-root.test.ts -t 'leaves the root resumable' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/authored-root.test.ts (27 tests | 24 skipped) 23ms

 Test Files  1 passed (1)
      Tests  3 passed | 24 skipped (27)
   Start at  01:34:32
   Duration  1.28s (transform 664ms, setup 16ms, collect 1.09s, tests 23ms, environment 0ms, prepare 41ms)

exit=0
```
