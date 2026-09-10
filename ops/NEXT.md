# NEXT — WP-gate3-hn-monitor-runner

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

**Context:** RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

**Prior attempt (PR #83, closed):** produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt:

1. **Fail-closed on journal errors.** #83's `catch (err) { onPollError(err) }` swallowed EVERY error including `eventSubmit` journal failures — violates covenant 2 (fail-closed) and RFC-0001 §1. Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner. Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** #83 added `await worker.close()` to shutdown but the current `close()` only drains local promises — it does NOT tell the kernel to release the worker registration. Either:
   - Add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()` (preferred — completes the shutdown contract), OR
   - Add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do

3. **Class field declaration order.** #83 declared `private readonly fetcher` AFTER the constructor. Works today because of ES2022 hoisting semantics but breaks silently if someone adds `= someDefault` to a declaration. Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal.** #83 registered `SIGTERM`/`SIGINT` handlers on the process directly with no opt-out. A library user embedding this can't cancel one runner without affecting others. Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch.** #83's tests never asserted the loop survives a fetcher throw AND the loop TERMINATES on a journal throw. Add both cases; without them, someone regresses `onPollError` to a no-op and every test still passes.

## The task

Add `sdk/src/hn-monitor-runner.ts`. It composes the existing pieces into a continuous runner:

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

## Explicit non-goals for THIS PR (belongs to later sub-PRs)

  - Proving the workload actually executes end-to-end (dispatch → step complete). That is sub-PR B (integration test with real relayflowd + fake HN fetch + assert step reaches `done`). This PR ONLY proves the runner assembles and its unit tests hold.
  - CLI wrapper (`flows hn-monitor start`). That is sub-PR C.
  - Ops/STATE.md gate-2 GREEN declaration. That is sub-PR D.

Say all three explicitly in the PR body so the history lens doesn't reject on "runner doesn't prove workload runs."

## Definition of done

  - `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`
  - `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do
  - `sdk/src/protocol.ts` — if you added `workerRelease`, matching request/response definitions
  - `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these:
    - fake fetch + mock journal client → runner submits an event on each tick
    - abort signal triggers clean shutdown within one tick (worker released or documented)
    - worker attach happens before first poll
    - **fetch throw → loop survives** (onPollError called, next tick still runs)
    - **journal throw → loop TERMINATES** (runner.run() rejects with the error)
  - `cd sdk && npm test` green (pretest hook builds the kernel automatically)
  - EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in your summary
  - PR body explicitly names the non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D)
  - ops/NEXT.md correctly says Gate 2, not Gate 3 (the assessor on #83 confused itself)
  - as your LAST action, run `git status --porcelain` and paste it

## Out of scope for THIS tick — DO NOT TOUCH

  - `.github/workflows/*` — no GHA changes
  - `kernel/*` — the kernel side of gate 2 already works via PR #14
  - `workflows/*.yaml` — those are for later sub-PRs
  - `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
  - CLI wrapper — sub-PR C, separate PR
  - end-to-end integration test with real relayflowd — sub-PR B, separate PR
  - ops/STATE.md gate-2 declaration — sub-PR D, separate PR
