# NEXT — work package for this tick

**Gate:** Gate 2 (proactive agent)

**Objective:** Build `sdk/src/hn-monitor-runner.ts` — a continuous polling runner that composes the existing HN poller, journal client, and agent worker into a production-ready service.

**Scope from TARGET.md (quoted, not cited):**

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

Context: RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

Prior attempt (PR #83, closed): produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt:

1. **Fail-closed on journal errors.** #83's `catch (err) { onPollError(err) }` swallowed EVERY error including `eventSubmit` journal failures — violates covenant 2 (fail-closed) and RFC-0001 §1. Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner. Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** #83 added `await worker.close()` to shutdown but the current `close()` only drains local promises — it does NOT tell the kernel to release the worker registration. Either:
   - Add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()` (preferred — completes the shutdown contract), OR
   - Add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do

3. **Class field declaration order.** #83 declared `private readonly fetcher` AFTER the constructor. Works today because of ES2022 hoisting semantics but breaks silently if someone adds `= someDefault` to a declaration. Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal.** #83 registered `SIGTERM`/`SIGINT` handlers on the process directly with no opt-out. A library user embedding this can't cancel one runner without affecting others. Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch.** #83's tests never asserted the loop survives a fetcher throw AND the loop TERMINATES on a journal throw. Add both cases; without them, someone regresses `onPollError` to a no-op and every test still passes.

The task: Add `sdk/src/hn-monitor-runner.ts`. It composes the existing pieces into a continuous runner:
- constructs a `JournalClient` connected to the running `relayflowd` socket
- constructs an `AgentWorker` (from `sdk/src/worker.ts`) and calls `workerAttach()` for `agent` steps — attach BEFORE first poll (a run parked because no worker attached is only revived by `run.resume`; the live-kernel suite pins this)
- loops: `pollHackerNewsOnce(spec, sink)` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000 = 60s) → repeat
- exit cleanly on `AbortSignal.abort` (drain in-flight steps, close client, release worker per finding #2)
- exported from `sdk/src/index.ts`

Keep it small and honest:
- the worker must attach BEFORE the first poll
- the poller layer handles single-fetch failures with a typed error; the loop just moves to the next tick — but journal errors MUST fail the runner (finding #1)
- no scheduling logic beyond the sleep (the kernel owns retry and dedupe policy)
- no LLM calls; the runner is glue, not a reviewer

Explicit non-goals for THIS PR (belongs to later sub-PRs):
- Proving the workload actually executes end-to-end (dispatch → step complete). That is sub-PR B (integration test with real relayflowd + fake HN fetch + assert step reaches `done`). This PR ONLY proves the runner assembles and its unit tests hold.
- CLI wrapper (`flows hn-monitor start`). That is sub-PR C.
- Ops/STATE.md gate-2 GREEN declaration. That is sub-PR D.

**BLOCKED STATUS:** The SDK does not compile at HEAD. Cannot add new code or tests until this is fixed.

TypeScript build fails with 16 errors from missing exports in `@relayflows/surface`:

```
src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
src/helper-writeback.ts(5,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,42): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'invokeHelper'.
src/helper-writeback.ts(5,61): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/helper-writeback.ts(22,41): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/preflight.ts(7,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/slack-preflight.ts(3,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/slack-preflight.ts(18,55): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/slack-writeback.ts(3,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
src/slack-writeback.ts(58,65): error TS18046: 'call.params.text' is of type 'unknown'.
src/slack-writeback.ts(58,94): error TS2345: Argument of type 'unknown' is not assignable to parameter of type '{ replyTo?: string | undefined; } | undefined'.
src/trigger-executor.ts(1,10): error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
src/trigger-executor.ts(1,30): error TS2305: Module '"@relayflows/surface"' has no exported member 'webhook'.
src/trigger-executor.ts(1,44): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/trigger-executor.ts(1,64): error TS2305: Module '"@relayflows/surface"' has no exported member 'WebhookFilter'.
```

Reproduction (literal command and output):

```
$ cd /project/workflows/runs/21fe65da-df8e-4a5c-baa7-0238c6d939b7/packages/sdk
$ npm ci
[succeeds, dependencies installed]
$ npm test
npm error code 2
npm error command sh -c npm run build
[16 TypeScript errors as shown above]
```

Additional context: The `packages/surface/` directory does not exist in this worktree. This appears to be a snapshot environment (per STATE.md "Known environment faults in a cloud sandbox" §1: "No `.git`, no `gh`. `sync` runs in `SYNC_MODE=snapshot`"). The surface package may not have been synced, or its src/ may be gitignored/excluded.

**Files in scope (IF UNBLOCKED):**
- `packages/sdk/src/hn-monitor-runner.ts` (new)
- `packages/sdk/src/worker.ts` (potentially: add worker release or document its absence per finding #2)
- `packages/sdk/src/protocol.ts` (potentially: add `workerRelease` verb if needed)
- `packages/sdk/src/index.ts` (export the new runner)
- `packages/sdk/tests/hn-monitor-runner.test.ts` (new, covering all 5 test cases from findings)

**Definition of done (IF UNBLOCKED):**
- `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`
- `sdk/src/worker.ts` — either `close()` calls `workerRelease`, OR a one-line comment names what close() intentionally does NOT do (comment already exists per current worker.ts:31-36)
- `sdk/src/protocol.ts` — if you added `workerRelease`, matching request/response definitions
- `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these:
  - fake fetch + mock journal client → runner submits an event on each tick
  - abort signal triggers clean shutdown within one tick (worker released or documented)
  - worker attach happens before first poll
  - **fetch throw → loop survives** (onPollError called, next tick still runs)
  - **journal throw → loop TERMINATES** (runner.run() rejects with the error)
- `cd sdk && npm test` green (pretest hook builds the kernel automatically per package.json:39)
- EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in summary
- PR body explicitly names the non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D)
- As final action: `git status --porcelain` output pasted

**Explicitly OUT of scope:**
- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
- CLI wrapper — sub-PR C, separate PR
- end-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR

**Why blocked:** The gate-2 target is reachable and well-specified. All primitives exist (worker.ts from PR #53, hn-poller.ts, journal-client.ts). The five findings from PR #83 are specific and actionable. But the SDK won't compile, so no new code can be written or tested. The blocker is SDK infrastructure (missing surface exports), not the runner itself.
