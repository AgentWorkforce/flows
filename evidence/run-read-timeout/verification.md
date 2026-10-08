Captured verification at the review-fix source. Commands and output below are verbatim (absolute paths included): relayflowd is built from this tree by the kernel-build command, and both live suites run against that binary. [full-suite-final.log](full-suite-final.log) is the earlier full-suite transcript from before the review fixes (head a50a8de); it records that run's environment failures and does not cover the review-fix changes.

## kernel-build.log

```text
$ cd kernel && CARGO_TARGET_DIR=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.04s
exit=0
```

## final-focused.log

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target/debug/relayflowd npx vitest run tests/journal-client-read-timeout.test.ts tests/journal-client.test.ts tests/journal-client-completion.test.ts tests/journal-client-subscriptions.test.ts tests/running-step-watch.test.ts tests/heartbeat-timeout.test.ts tests/run-daemon-unresponsive.test.ts tests/authored-root.test.ts tests/classify-outcome.test.ts tests/cli.test.ts tests/direct-run-worker-lease.test.ts tests/resume-worker-lease.test.ts tests/worker-lease.test.ts tests/worker-lease-lost.test.ts tests/worker-lease-lost-live.test.ts tests/worker-lease-sweep.test.ts tests/run-read-load-live.test.ts tests/flow-executor-chain.test.ts tests/agent-transcript-live.test.ts tests/human-live.test.ts tests/reuse-summary-interruption.test.ts tests/memoization.test.ts tests/authored-verifier-read-budget.test.ts tests/communication-worker.test.ts tests/communication.test.ts tests/helper-effect-lease-loss.test.ts tests/authored-helpers.test.ts tests/authored-flow-slack.test.ts tests/effect-channel.test.ts --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/cli.test.ts (71 tests) 5259ms
   ✓ flows run/resume CLI over the journal protocol > follows a dispatched worker step instead of reporting a protocol error 2035ms
   ✓ flows run/resume CLI over the journal protocol > follows a worker wait past a locally expired lease until the daemon settles it 2037ms
(node:703660) [FLOWS_ROOT_LEASE_LOST] Warning: authored root run_id=root-run attempt=1: lease_conflict: attempt has no active worker lease. Waiting for the kernel to retry it.
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/authored-root.test.ts (36 tests) 454ms
 ✓ tests/journal-client-read-timeout.test.ts (31 tests) 2103ms
   ✓ an exhausted budget during reader setup frees the queue for the next read 302ms
 ✓ tests/journal-client.test.ts (17 tests) 86ms
 ✓ tests/flow-executor-chain.test.ts (14 tests) 7518ms
   ✓ flow executor LLM and output-binding chain > runs f.llm -> f.agent -> f.run with schema-verified journal output and the exact allowed model 651ms
   ✓ flow executor LLM and output-binding chain > runs the exact authored flagship f.llm -> f.agent -> f.run path through the durable CLI root 1074ms
   ✓ flow executor LLM and output-binding chain > resumes an interrupted durable authored root without replaying completed flagship effects 2745ms
   ✓ flow executor LLM and output-binding chain > passes a declarative verified value through an agent into a deterministic artifact 327ms
   ✓ flow executor LLM and output-binding chain > flows run consumes YAML bindings and resume reuses the original journal output 826ms
 ✓ tests/authored-flow-slack.test.ts (7 tests) 1181ms
   ✓ authored Slack helper effects > replays after SIGKILL before confirm with the same token and one successful completion 421ms
   ✓ authored Slack helper effects > replays after SIGKILL before complete with the same token and one successful completion 416ms
 ✓ tests/running-step-watch.test.ts (14 tests) 12314ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2115ms
   ✓ cancels promptly while a lease snapshot read is in flight 2006ms
   ✓ a completion push ends the wait without waiting out an in-flight snapshot 2053ms
   ✓ a completion that aborts the snapshot is not an error even if a retry starts at once 2003ms
   ✓ a malformed watch frame during an in-flight snapshot is an error, not a completion 2002ms
   ✓ a watch dropped during an in-flight snapshot is reported at once, not after the read budget 2002ms
 ✓ tests/agent-transcript-live.test.ts (4 tests) 2581ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured agent failure details and its completed root index 671ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured llm failure details and its completed root index 591ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > journals the digest in trajectory_tail on a successful agent step and writes the file it points at 646ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > on a failed agent step, names the failure and the transcript in the terminal diagnostic, redacted 671ms
 ✓ tests/authored-helpers.test.ts (6 tests) 1883ms
   ✓ runs every available provider through the real kernel and resumes completed effects without a second write 882ms
   ✓ replays after SIGKILL before confirm with the same token and one successful completion 390ms
   ✓ replays after SIGKILL before complete with the same token and one successful completion 389ms
 ✓ tests/classify-outcome.test.ts (11 tests) 7415ms
   ✓ classifyOutcome > gives up and reports when a running run never becomes classifiable 2005ms
   ✓ the remedy on a worker park > follows a step through a retry backoff longer than the unclassified bound 3004ms
   ✓ the remedy on a worker park > follows a run.start outcome that is already running on a retried attempt 2000ms
 ✓ tests/human-live.test.ts (3 tests) 4571ms
   ✓ f.human against a real daemon > parks with the question, refuses wrong answers, records one, and resumes to success 2744ms
   ✓ f.human against a real daemon > a "no" is a value the body branches on: declined, exit 0, no effect 1038ms
   ✓ f.human against a real daemon > refuses to answer a run the daemon does not know 787ms
 ✓ tests/communication-worker.test.ts (20 tests) 1815ms
 ✓ tests/worker-lease.test.ts (8 tests) 12ms
 ✓ tests/worker-lease-lost.test.ts (17 tests) 20ms
 ✓ tests/communication.test.ts (10 tests) 17ms
 ✓ tests/effect-channel.test.ts (5 tests) 259ms
 ✓ tests/worker-lease-lost-live.test.ts (3 tests) 632ms
 ✓ tests/run-daemon-unresponsive.test.ts (5 tests) 6ms
 ✓ tests/memoization.test.ts (58 tests) 65ms
 ✓ tests/run-read-load-live.test.ts (2 tests) 2413ms
   ✓ completes a CPU-saturating deterministic flow with reads in flight and preserves its journal 2055ms
   ✓ drains read and watch promises before an authored flow completes 358ms
 ✓ tests/reuse-summary-interruption.test.ts (6 tests) 4ms
 ✓ tests/worker-lease-sweep.test.ts (4 tests) 7ms
 ✓ tests/journal-client-completion.test.ts (6 tests) 105ms
 ✓ tests/resume-worker-lease.test.ts (3 tests) 7ms
 ✓ tests/direct-run-worker-lease.test.ts (3 tests) 7ms
 ✓ tests/helper-effect-lease-loss.test.ts (1 test) 228ms
 ✓ tests/journal-client-subscriptions.test.ts (1 test) 8ms
 ✓ tests/authored-verifier-read-budget.test.ts (2 tests) 31ms
 ✓ tests/heartbeat-timeout.test.ts (1 test) 17ms

 Test Files  29 passed (29)
      Tests  369 passed (369)
   Start at  06:06:10
   Duration  61.49s (transform 1.15s, setup 153ms, collect 6.89s, tests 51.02s, environment 4ms, prepare 1.03s)

exit=0
```

## resume-live.log

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/kernel-target/debug/relayflowd npx vitest run tests/read-timeout-resume-live.test.ts

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/read-timeout-resume-live.test.ts (1 test) 876ms
   ✓ parks an unreadable authored root and resumes without repeating its journaled effect 876ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  06:07:12
   Duration  2.15s (transform 629ms, setup 15ms, collect 1.02s, tests 876ms, environment 0ms, prepare 52ms)

exit=0
```

The mutation sections below were regenerated by `cd packages/sdk && python3 ../../evidence/run-read-timeout/mutations.py` (the command used) against the review-fix source; each mutation fails its test and the restored source passes.

## mutation-reader.log

```text
Source: packages/sdk/src/journal-budgeted-reads.ts
Original SHA256: 06ce5e0ba9248b0aae4d5973b91ad24b60c5333724bc53e395200f5c121f1510
Replaced:
return await reader.requestOnce(verb, params, remaining, attemptSignal);
With:
return await this.primary.requestOnce(verb, params, remaining, attemptSignal);

REVERTED
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'serves a bounded read' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/journal-client-read-timeout.test.ts (31 tests | 1 failed | 30 skipped) 113ms
   × serves a bounded read while an unbounded command is in flight 112ms
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
      Tests  1 failed | 30 skipped (31)
   Start at  06:05:36
   Duration  588ms (transform 178ms, setup 16ms, collect 303ms, tests 113ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 06ce5e0ba9248b0aae4d5973b91ad24b60c5333724bc53e395200f5c121f1510
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'serves a bounded read' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (31 tests | 30 skipped) 107ms

 Test Files  1 passed (1)
      Tests  1 passed | 30 skipped (31)
   Start at  06:05:37
   Duration  570ms (transform 180ms, setup 17ms, collect 302ms, tests 107ms, environment 0ms, prepare 40ms)

exit=0
```

## mutation-reader-reconnect.log

```text
Source: packages/sdk/src/journal-budgeted-reads.ts
Original SHA256: 06ce5e0ba9248b0aae4d5973b91ad24b60c5333724bc53e395200f5c121f1510
Replaced:
        this.drop(reader);

With:


REVERTED
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'reconnects the reader after it disconnects' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/journal-client-read-timeout.test.ts (31 tests | 1 failed | 30 skipped) 1007ms
   × reconnects the reader after it disconnects within the read budget 1006ms
     → journal client: run.get read session was interrupted after 81 attempts in 1000ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/journal-client-read-timeout.test.ts > reconnects the reader after it disconnects within the read budget
JournalReadInterruptedError: journal client: run.get read session was interrupted after 81 attempts in 1000ms (read budget 1000ms): journal client: not connected (run.get): journal client: connection closed
 ❯ exhausted src/journal-read-policy.ts:71:9
     69|     let last: unknown;
     70|     const exhausted = () => last instanceof JournalReadInterruptedError
     71|       ? new JournalReadInterruptedError(verb, attempts, performance.no…
       |         ^
     72|       : new JournalRequestTimeoutError(verb, timeoutMs, attempts, perf…
     73|     // A caller's cancellation settles this read and drains its queued…
 ❯ Timeout.<anonymous> src/journal-read-policy.ts:86:48

Caused by: Error: journal client: not connected (run.get): journal client: connection closed
 ❯ src/journal-connection.ts:183:16
 ❯ JournalClient.requestOnce src/journal-connection.ts:176:12
 ❯ src/journal-budgeted-reads.ts:60:29
 ❯ src/journal-read-policy.ts:98:18

Caused by: Error: journal client: connection closed
 ❯ Socket.<anonymous> src/journal-connection.ts:89:26

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 30 skipped (31)
   Start at  06:05:38
   Duration  1.47s (transform 180ms, setup 17ms, collect 308ms, tests 1.01s, environment 0ms, prepare 40ms)

exit=1

RESTORED SHA256: 06ce5e0ba9248b0aae4d5973b91ad24b60c5333724bc53e395200f5c121f1510
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'reconnects the reader after it disconnects' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (31 tests | 30 skipped) 86ms

 Test Files  1 passed (1)
      Tests  1 passed | 30 skipped (31)
   Start at  06:05:40
   Duration  543ms (transform 170ms, setup 17ms, collect 283ms, tests 86ms, environment 0ms, prepare 45ms)

exit=0
```

## mutation-reader-setup-retry.log

```text
Source: packages/sdk/src/journal-budgeted-reads.ts
Original SHA256: 06ce5e0ba9248b0aae4d5973b91ad24b60c5333724bc53e395200f5c121f1510
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

 ❯ tests/journal-client-read-timeout.test.ts (31 tests | 1 failed | 30 skipped) 76ms
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
      Tests  1 failed | 30 skipped (31)
   Start at  06:05:41
   Duration  535ms (transform 179ms, setup 16ms, collect 302ms, tests 76ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 06ce5e0ba9248b0aae4d5973b91ad24b60c5333724bc53e395200f5c121f1510
$ cd packages/sdk && npx vitest run tests/journal-client-read-timeout.test.ts -t 'retries a reader setup that timed out' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/journal-client-read-timeout.test.ts (31 tests | 30 skipped) 67ms

 Test Files  1 passed (1)
      Tests  1 passed | 30 skipped (31)
   Start at  06:05:42
   Duration  527ms (transform 174ms, setup 17ms, collect 298ms, tests 67ms, environment 0ms, prepare 40ms)

exit=0
```

## mutation-watch-cadence.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: 2a5f6adeca146e6188ac5e6d129db004e71574cf09df397fd4b9127c50e9b5aa
Replaced:
const LEASE_POLL_MS = 2_000;
With:
const LEASE_POLL_MS = 50;

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (14 tests | 1 failed | 13 skipped) 2110ms
   × uses pushes for completion with lease-cadence reads and releases its watcher 2109ms
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
      Tests  1 failed | 13 skipped (14)
   Start at  06:05:43
   Duration  2.60s (transform 189ms, setup 17ms, collect 325ms, tests 2.11s, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 2a5f6adeca146e6188ac5e6d129db004e71574cf09df397fd4b9127c50e9b5aa
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'uses pushes for completion' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (14 tests | 13 skipped) 2117ms
   ✓ uses pushes for completion with lease-cadence reads and releases its watcher 2117ms

 Test Files  1 passed (1)
      Tests  1 passed | 13 skipped (14)
   Start at  06:05:46
   Duration  2.60s (transform 191ms, setup 16ms, collect 325ms, tests 2.12s, environment 0ms, prepare 41ms)

exit=0
```

## mutation-snapshot-cancel.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: 2a5f6adeca146e6188ac5e6d129db004e71574cf09df397fd4b9127c50e9b5aa
Replaced:
const signal = options.signal === undefined ? read.signal
        : AbortSignal.any([options.signal, read.signal]);
With:
const signal = read.signal;

REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (14 tests | 1 failed | 13 skipped) 2218ms
   × cancels promptly while a lease snapshot read is in flight 2217ms
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
      Tests  1 failed | 13 skipped (14)
   Start at  06:05:48
   Duration  2.71s (transform 191ms, setup 17ms, collect 325ms, tests 2.22s, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 2a5f6adeca146e6188ac5e6d129db004e71574cf09df397fd4b9127c50e9b5aa
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'cancels promptly while a lease snapshot read is in flight' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (14 tests | 13 skipped) 2011ms
   ✓ cancels promptly while a lease snapshot read is in flight 2010ms

 Test Files  1 passed (1)
      Tests  1 passed | 13 skipped (14)
   Start at  06:05:52
   Duration  2.50s (transform 191ms, setup 16ms, collect 328ms, tests 2.01s, environment 0ms, prepare 41ms)

exit=0
```

## mutation-completion-aborts-snapshot.log

```text
Source: packages/sdk/src/cli/running-step.ts
Original SHA256: 2a5f6adeca146e6188ac5e6d129db004e71574cf09df397fd4b9127c50e9b5aa
Replaced:
snapshotRead?.abort(new Error(`step "${runningStep.id}" completed during the lease snapshot`));
With:


REVERTED
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'a completion push ends the wait' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/running-step-watch.test.ts (14 tests | 1 failed | 13 skipped) 3012ms
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
      Tests  1 failed | 13 skipped (14)
   Start at  06:05:54
   Duration  3.52s (transform 201ms, setup 17ms, collect 341ms, tests 3.01s, environment 0ms, prepare 43ms)

exit=1

RESTORED SHA256: 2a5f6adeca146e6188ac5e6d129db004e71574cf09df397fd4b9127c50e9b5aa
$ cd packages/sdk && npx vitest run tests/running-step-watch.test.ts -t 'a completion push ends the wait' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/running-step-watch.test.ts (14 tests | 13 skipped) 2060ms
   ✓ a completion push ends the wait without waiting out an in-flight snapshot 2059ms

 Test Files  1 passed (1)
      Tests  1 passed | 13 skipped (14)
   Start at  06:05:58
   Duration  2.53s (transform 188ms, setup 16ms, collect 312ms, tests 2.06s, environment 0ms, prepare 40ms)

exit=0
```

## mutation-heartbeat.log

```text
Source: packages/sdk/src/worker-lease.ts
Original SHA256: 4c58d4670422dc2169764af16eb082c55e72c5321ed9d6001af3607f03955fa3
Replaced:
      if (error instanceof JournalRequestTimeoutError && error.verb === 'step.heartbeat') {
        throw new WorkerLeaseLostError('renewal_expired', error.message, { cause: error });
      }

With:


REVERTED
$ cd packages/sdk && npx vitest run tests/heartbeat-timeout.test.ts -t 'a heartbeat timeout' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ❯ tests/heartbeat-timeout.test.ts (1 test | 1 failed) 20ms
   × a heartbeat timeout is lease loss rather than a worker body failure 19ms
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
   Start at  06:06:01
   Duration  467ms (transform 164ms, setup 14ms, collect 286ms, tests 20ms, environment 0ms, prepare 42ms)

exit=1

RESTORED SHA256: 4c58d4670422dc2169764af16eb082c55e72c5321ed9d6001af3607f03955fa3
$ cd packages/sdk && npx vitest run tests/heartbeat-timeout.test.ts -t 'a heartbeat timeout' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/heartbeat-timeout.test.ts (1 test) 16ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  06:06:02
   Duration  449ms (transform 164ms, setup 17ms, collect 280ms, tests 16ms, environment 0ms, prepare 40ms)

exit=0
```

## mutation-root-parking.log

```text
Source: packages/sdk/src/authored-root.ts
Original SHA256: 8e3bd4ebe8b470c1486f1ab6adcf2fd81ba19e6a173e2531e7cbc59b16bcba29
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

 ❯ tests/authored-root.test.ts (36 tests | 3 failed | 33 skipped) 31ms
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

 ❯ tests/authored-root.test.ts:424:5
    422|     });
    423|     const journal = new RootJournal();
    424|     await expect(executeDurableAuthoredFlow(loaded, journal as unknown…
       |     ^
    425|       { dataDir: '/unused', admissionKey: 'read-timeout' })).rejects.t…
    426|         code: 'daemon_unresponsive', rootRunId: 'root-run', message: e…

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

 ❯ tests/authored-root.test.ts:424:5
    422|     });
    423|     const journal = new RootJournal();
    424|     await expect(executeDurableAuthoredFlow(loaded, journal as unknown…
       |     ^
    425|       { dataDir: '/unused', admissionKey: 'read-timeout' })).rejects.t…
    426|         code: 'daemon_unresponsive', rootRunId: 'root-run', message: e…

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

 ❯ tests/authored-root.test.ts:437:5
    435|     const loaded = await fixture(false, 0, async () => { throw interru…
    436|     const journal = new RootJournal();
    437|     await expect(executeDurableAuthoredFlow(loaded, journal as unknown…
       |     ^
    438|       { dataDir: '/unused', admissionKey: 'read-disconnect' })).reject…
    439|         code: 'daemon_unresponsive', rootRunId: 'root-run', message: e…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯

 Test Files  1 failed (1)
      Tests  3 failed | 33 skipped (36)
   Start at  06:06:03
   Duration  1.31s (transform 677ms, setup 16ms, collect 1.12s, tests 31ms, environment 0ms, prepare 41ms)

exit=1

RESTORED SHA256: 8e3bd4ebe8b470c1486f1ab6adcf2fd81ba19e6a173e2531e7cbc59b16bcba29
$ cd packages/sdk && npx vitest run tests/authored-root.test.ts -t 'leaves the root resumable' --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /home/khaliqgant/Projects/AgentWorkforce/flows-worktrees/pr613/packages/sdk

 ✓ tests/authored-root.test.ts (36 tests | 33 skipped) 23ms

 Test Files  1 passed (1)
      Tests  3 passed | 33 skipped (36)
   Start at  06:06:05
   Duration  1.31s (transform 683ms, setup 16ms, collect 1.12s, tests 23ms, environment 0ms, prepare 40ms)

exit=0
```
