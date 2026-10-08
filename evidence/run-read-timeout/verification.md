Captured verification. Commands and output below are verbatim; the full-suite log is linked from summary.md.

## final-focused.log

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd npx vitest run tests/journal-client-read-timeout.test.ts tests/journal-client.test.ts tests/journal-client-completion.test.ts tests/journal-client-subscriptions.test.ts tests/running-step-watch.test.ts tests/heartbeat-timeout.test.ts tests/run-daemon-unresponsive.test.ts tests/authored-root.test.ts tests/classify-outcome.test.ts tests/cli.test.ts tests/direct-run-worker-lease.test.ts tests/resume-worker-lease.test.ts tests/worker-lease.test.ts tests/worker-lease-lost.test.ts tests/worker-lease-sweep.test.ts tests/run-read-load-live.test.ts tests/worker-lease-lost-live.test.ts tests/flow-executor-chain.test.ts tests/agent-transcript-live.test.ts tests/human-live.test.ts --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/cli.test.ts (71 tests) 6026ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 566ms
   ✓ flows check CLI > resolves a bare PATH-resolved claude with no declared model, in an isolated PATH 488ms
   ✓ flows run/resume CLI over the journal protocol > follows a dispatched worker step instead of reporting a protocol error 2053ms
   ✓ flows run/resume CLI over the journal protocol > follows a worker wait past a locally expired lease until the daemon settles it 2045ms
(node:44939) [FLOWS_ROOT_LEASE_LOST] Warning: authored root run_id=root-run attempt=1: lease_conflict: attempt has no active worker lease. Waiting for the kernel to retry it.
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/authored-root.test.ts (26 tests) 398ms
 ✓ tests/journal-client.test.ts (17 tests) 89ms
 ✓ tests/flow-executor-chain.test.ts (14 tests) 10315ms
   ✓ flow executor LLM and output-binding chain > runs f.llm -> f.agent -> f.run with schema-verified journal output and the exact allowed model 1022ms
   ✓ flow executor LLM and output-binding chain > runs a dollar-budgeted authored Claude agent with the same default used by preflight 700ms
   ✓ flow executor LLM and output-binding chain > runs the exact authored flagship f.llm -> f.agent -> f.run path through the durable CLI root 1595ms
   ✓ flow executor LLM and output-binding chain > resumes an interrupted durable authored root without replaying completed flagship effects 3382ms
   ✓ flow executor LLM and output-binding chain > passes a declarative verified value through an agent into a deterministic artifact 779ms
   ✓ flow executor LLM and output-binding chain > flows run consumes YAML bindings and resume reuses the original journal output 1068ms
 ✓ tests/agent-transcript-live.test.ts (4 tests) 3394ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured agent failure details and its completed root index 875ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured llm failure details and its completed root index 818ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > journals the digest in trajectory_tail on a successful agent step and writes the file it points at 851ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > on a failed agent step, names the failure and the transcript in the terminal diagnostic, redacted 848ms
 ✓ tests/classify-outcome.test.ts (11 tests) 7422ms
   ✓ classifyOutcome > gives up and reports when a running run never becomes classifiable 2009ms
   ✓ the remedy on a worker park > follows a step through a retry backoff longer than the unclassified bound 3005ms
   ✓ the remedy on a worker park > follows a run.start outcome that is already running on a retried attempt 2001ms
 ✓ tests/human-live.test.ts (3 tests) 7854ms
   ✓ f.human against a real daemon > parks with the question, refuses wrong answers, records one, and resumes to success 4785ms
   ✓ f.human against a real daemon > a "no" is a value the body branches on: declined, exit 0, no effect 1916ms
   ✓ f.human against a real daemon > refuses to answer a run the daemon does not know 1152ms
 ✓ tests/worker-lease.test.ts (7 tests) 20ms
 ✓ tests/worker-lease-lost.test.ts (17 tests) 27ms
 ✓ tests/journal-client-read-timeout.test.ts (13 tests) 1104ms
   ✓ a recovered read timeout does not become an authored callback failure 368ms
 ✓ tests/worker-lease-lost-live.test.ts (3 tests) 943ms
   ✓ reports journal success after completion rejects with lease_conflict 327ms
   ✓ reports journal success when a renewal rejects after completion landed 327ms
 ✓ tests/run-read-load-live.test.ts (2 tests) 2821ms
   ✓ completes a CPU-saturating deterministic flow with reads in flight and preserves its journal 2095ms
   ✓ drains read and watch promises before an authored flow completes 725ms
 ✓ tests/worker-lease-sweep.test.ts (4 tests) 8ms
 ✓ tests/journal-client-completion.test.ts (6 tests) 102ms
 ✓ tests/resume-worker-lease.test.ts (3 tests) 6ms
 ✓ tests/direct-run-worker-lease.test.ts (3 tests) 10ms
 ✓ tests/running-step-watch.test.ts (2 tests) 2122ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2118ms
 ✓ tests/journal-client-subscriptions.test.ts (1 test) 8ms
 ✓ tests/run-daemon-unresponsive.test.ts (2 tests) 4ms
 ✓ tests/heartbeat-timeout.test.ts (1 test) 16ms

 Test Files  20 passed (20)
      Tests  210 passed (210)
   Start at  10:41:25
   Duration  54.29s (transform 1.45s, setup 97ms, collect 8.09s, tests 42.69s, environment 3ms, prepare 1.05s)

exit=0
```

## resume-live.log

```text
$ cd packages/sdk && npx vitest run tests/read-timeout-resume-live.test.ts
$ cd packages/sdk && npx vitest run tests/read-timeout-resume-live.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/read-timeout-resume-live.test.ts (1 test) 1512ms
   ✓ parks an unreadable authored root and resumes without repeating its journaled effect 1511ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  10:49:12
   Duration  3.20s (transform 891ms, setup 54ms, collect 1.39s, tests 1.51s, environment 0ms, prepare 43ms)

exit=0
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

 ❯ tests/journal-client-read-timeout.test.ts (17 tests | 1 failed | 16 skipped) 113ms
   × serves a bounded read while an unbounded command is in flight 112ms
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
   Start at  23:37:15
   Duration  572ms (transform 170ms, setup 17ms, collect 295ms, tests 113ms, environment 0ms, prepare 42ms)

exit=1

RESTORED SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'serves a bounded read' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (17 tests | 16 skipped) 107ms

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  23:37:16
   Duration  556ms (transform 169ms, setup 17ms, collect 293ms, tests 107ms, environment 0ms, prepare 40ms)

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

 ❯ tests/journal-client-read-timeout.test.ts (17 tests | 1 failed | 16 skipped) 1007ms
   × reconnects the reader after it disconnects within the read budget 1006ms
     → journal client: run.get read session was interrupted after 79 attempts in 1001ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > reconnects the reader after it disconnects within the read budget
JournalReadInterruptedError: journal client: run.get read session was interrupted after 79 attempts in 1001ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed
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
   Start at  23:37:16
   Duration  1.45s (transform 170ms, setup 18ms, collect 289ms, tests 1.01s, environment 0ms, prepare 42ms)

exit=1

RESTORED SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'reconnects the reader after it disconnects' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (17 tests | 16 skipped) 76ms

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  23:37:18
   Duration  532ms (transform 166ms, setup 16ms, collect 295ms, tests 76ms, environment 0ms, prepare 41ms)

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

 ❯ tests/journal-client-read-timeout.test.ts (17 tests | 1 failed | 16 skipped) 72ms
   × retries a reader setup that timed out instead of reading on the primary for good 71ms
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
   Start at  23:37:19
   Duration  495ms (transform 161ms, setup 17ms, collect 270ms, tests 72ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: e840ea971905def84fdecf0c3826430f058e0a88cf5650627fe0ca4fc4faa299
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'retries a reader setup that timed out' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (17 tests | 16 skipped) 75ms

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  23:37:20
   Duration  513ms (transform 164ms, setup 17ms, collect 287ms, tests 75ms, environment 0ms, prepare 40ms)

exit=0
```

## mutation-watch-cadence.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: a57da3dce86c9724d83bd3547a2d9186e05e7ea10409b743f89aaa25bf461bcd
Replaced:
const LEASE_POLL_MS = 2_000;
With:
const LEASE_POLL_MS = 50;

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (4 tests | 1 failed | 3 skipped) 2110ms
   × uses pushes for completion with lease-cadence reads and releases its watcher 2110ms
     → expected 41 to be less than or equal to 1

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/running-step-watch.test.ts > uses pushes for completion with lease-cadence reads and releases its watcher
AssertionError: expected 41 to be less than or equal to 1
 ❯ tests/running-step-watch.test.ts:37:19
     35|     await waitForRunningStep(client, 'run', { id: 'step', type: 'agent…
     36|     expect(performance.now() - start).toBeGreaterThan(2000);
     37|     expect(reads).toBeLessThanOrEqual(1);
       |                   ^
     38|     await sleep(10);
     39|     expect(watchClosed).toBe(true);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
   Start at  23:37:21
   Duration  2.57s (transform 168ms, setup 15ms, collect 294ms, tests 2.11s, environment 0ms, prepare 40ms)

exit=1

RESTORED SHA256: a57da3dce86c9724d83bd3547a2d9186e05e7ea10409b743f89aaa25bf461bcd
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (4 tests | 3 skipped) 2117ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2116ms

 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)
   Start at  23:37:24
   Duration  2.57s (transform 165ms, setup 17ms, collect 291ms, tests 2.12s, environment 0ms, prepare 41ms)

exit=0
```

## mutation-snapshot-cancel.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: a57da3dce86c9724d83bd3547a2d9186e05e7ea10409b743f89aaa25bf461bcd
Replaced:
client.runGet(runId, options.signal === undefined ? {} : { signal: options.signal })
With:
client.runGet(runId)

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (4 tests | 1 failed | 3 skipped) 2215ms
   × cancels promptly while a lease snapshot read is in flight 2214ms
     → expected 'still waiting' to be an instance of Error

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/running-step-watch.test.ts > cancels promptly while a lease snapshot read is in flight
AssertionError: expected 'still waiting' to be an instance of Error
 ❯ tests/running-step-watch.test.ts:81:21
     79|     controller.abort();
     80|     const settled = await Promise.race([outcome, sleep(200).then(() =>…
     81|     expect(settled).toBeInstanceOf(Error);
       |                     ^
     82|     expect((settled as Error).message).toContain('was canceled');
     83|   } finally { client.close(); await new Promise<void>(resolve => serve…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
   Start at  23:37:27
   Duration  2.65s (transform 164ms, setup 16ms, collect 281ms, tests 2.21s, environment 0ms, prepare 40ms)

exit=1

RESTORED SHA256: a57da3dce86c9724d83bd3547a2d9186e05e7ea10409b743f89aaa25bf461bcd
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (4 tests | 3 skipped) 2010ms
   ✓ cancels promptly while a lease snapshot read is in flight 2009ms

 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)
   Start at  23:37:30
   Duration  2.41s (transform 158ms, setup 15ms, collect 260ms, tests 2.01s, environment 0ms, prepare 34ms)

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

 ❯ tests/heartbeat-timeout.test.ts (1 test | 1 failed) 20ms
   × a heartbeat timeout is lease loss rather than a worker body failure 20ms
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
   Start at  23:37:33
   Duration  464ms (transform 162ms, setup 16ms, collect 283ms, tests 20ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 44c13f9f61ac13cb8c0f872f4c22b1c212e020d05880ed080ea7205ba6007213
$ cd packages/sdk && npx vitest run tests/heartbeat-timeout.test.ts -t 'a heartbeat timeout' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/heartbeat-timeout.test.ts (1 test) 16ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  23:37:33
   Duration  440ms (transform 163ms, setup 15ms, collect 272ms, tests 16ms, environment 0ms, prepare 37ms)

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
   Start at  23:37:34
   Duration  1.28s (transform 656ms, setup 16ms, collect 1.08s, tests 31ms, environment 0ms, prepare 43ms)

exit=1

RESTORED SHA256: 999d3eca1236966ca84d0c4a07694a7449bf0a35dd1e7fac455ab0f510804f1a
$ cd packages/sdk && npx vitest run tests/authored-root.test.ts -t 'leaves the root resumable' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/authored-root.test.ts (27 tests | 24 skipped) 25ms

 Test Files  1 passed (1)
      Tests  3 passed | 24 skipped (27)
   Start at  23:37:36
   Duration  1.24s (transform 647ms, setup 16ms, collect 1.06s, tests 25ms, environment 0ms, prepare 41ms)

exit=0
```
