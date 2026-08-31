# NEXT — work package for this tick

**Target gate: Gate 2** (Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK)

## Objective

Build `sdk/src/hn-monitor-runner.ts` that composes existing pieces (JournalClient, AgentWorker, pollHackerNewsOnce) into a continuous polling runner. This is sub-PR A of the gate-2 work: proof that the RUNNER exists and its unit tests hold. Integration testing (proof the workload EXECUTES end-to-end) is explicitly deferred to sub-PR B.

## Context from TARGET.md

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists:
- Event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`)
- Flow spec (`testdata/hn-monitor.flow.yaml`)
- Poller (`sdk/src/hn-poller.ts`)
- Agent worker (`sdk/src/worker.ts` from PR #53)
- One-shot demo (`sdk/src/demo-hn-monitor.ts`)

But nothing has ever run them together as a continuous workload. This PR fixes that.

## Prior attempt (PR #83, closed)

PR #83 produced a functional runner but was rejected by the swarm on five real findings. This attempt must address all five:

1. **Fail-closed on journal errors.** Split error handling: `try { fetch } catch { onFetchError }` around the network call (swallow network flakiness), `try { eventSubmit } catch { rethrow }` around the journal call (journal failures MUST throw and terminate).

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** Either add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()`, OR add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do.

3. **Class field declaration order.** Declare ALL fields at the top of the class body, before the constructor (prevents silent breakage if someone adds `= someDefault`).

4. **Signal handlers must be opt-in via AbortSignal.** Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController. A library user embedding this must be able to cancel one runner without affecting others.

5. **Test coverage for pollError branch.** Add tests asserting: loop survives a fetcher throw AND loop TERMINATES on a journal throw. Without them, someone regresses `onPollError` to a no-op and every test still passes.

## Files in scope

- `sdk/src/hn-monitor-runner.ts` — new file, the continuous runner
- `sdk/src/worker.ts` — MAY modify `close()` per finding #2, but do NOT rewrite the attach/dispatch/complete flow (PR #53 is merged)
- `sdk/src/protocol.ts` — if adding `workerRelease`, matching request/response definitions
- `sdk/src/index.ts` — export `HnMonitorRunner`
- `sdk/tests/hn-monitor-runner.test.ts` — unit tests (NOT end-to-end integration; that's sub-PR B)

## Definition of done (ALL must hold)

1. `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`

2. The runner composes existing pieces:
   - Constructs a `JournalClient` connected to the running `relayflowd` socket
   - Constructs an `AgentWorker` and calls `workerAttach()` for `agent` steps — attach BEFORE first poll (a run parked because no worker attached is only revived by `run.resume`)
   - Loops: `pollHackerNewsOnce(spec, sink)` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000 = 60s) → repeat
   - Exit cleanly on `AbortSignal.abort` (drain in-flight steps, close client, release worker per finding #2)

3. Keep it small and honest:
   - Worker must attach BEFORE the first poll
   - Poller layer handles single-fetch failures with a typed error; the loop just moves to the next tick — but journal errors MUST fail the runner (finding #1)
   - No scheduling logic beyond the sleep (kernel owns retry and dedupe policy)
   - No LLM calls; the runner is glue, not a reviewer

4. `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do

5. `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these:
   - Fake fetch + mock journal client → runner submits an event on each tick
   - Abort signal triggers clean shutdown within one tick (worker released or documented)
   - Worker attach happens before first poll
   - **Fetch throw → loop survives** (onPollError called, next tick still runs)
   - **Journal throw → loop TERMINATES** (runner.run() rejects with the error)

6. `cd sdk && npm test` green (pretest hook builds the kernel automatically). Paste the literal command and output tail showing test counts.

7. EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in summary.

8. As LAST action, run `git status --porcelain` and paste it.

## Explicit non-goals for THIS PR (belongs to later sub-PRs)

- **Proving the workload actually executes end-to-end** (dispatch → step complete). That is sub-PR B (integration test with real relayflowd + fake HN fetch + assert step reaches `done`). This PR ONLY proves the runner assembles and its unit tests hold.
- **CLI wrapper** (`flows hn-monitor start`). That is sub-PR C.
- **ops/STATE.md gate-2 GREEN declaration**. That is sub-PR D.

Say all three explicitly in the PR body so the history lens doesn't reject on "runner doesn't prove workload runs."

## Explicitly OUT of scope — DO NOT TOUCH

- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
- CLI wrapper — sub-PR C, separate PR
- End-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR

## Current state analysis

ASSESSED: The repository is in a cloud sandbox with no git history. Based on the file structure:

- `sdk/src/worker.ts` EXISTS (PR #53 merged) — the AgentWorker is complete
- `sdk/src/hn-poller.ts` EXISTS — the polling logic is done
- `sdk/src/demo-hn-monitor.ts` EXISTS — a one-shot demo
- `sdk/src/hn-monitor-runner.ts` DOES NOT EXIST — this is what needs to be built
- `sdk/tests/` has 203 tests passing

The work package is BUILDABLE from the current state. All dependencies exist.
