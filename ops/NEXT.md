# NEXT — Gate 2 HN Monitor Continuous Runner (Sub-PR A)

**Gate:** 2 — Proactive agent workloads
**Parent task:** Build the `hn-monitor` polling runner that composes existing SDK primitives into a continuous workload.

## Objective

Add `sdk/src/hn-monitor-runner.ts`: a continuous runner that polls Hacker News, submits events to the journal, and attaches an agent worker BEFORE the first poll. This is sub-PR A (scaffolding) of the gate-2 push. Explicitly deferred: integration test with real relayflowd (sub-PR B), CLI wrapper (sub-PR C), and ops/STATE.md gate-2 declaration (sub-PR D).

## Scope

**Files:**
- `packages/sdk/src/hn-monitor-runner.ts` (create)
- `packages/sdk/src/index.ts` (export new runner)
- `packages/sdk/src/protocol.ts` (add `workerRelease` verb if implementing finding #2's preferred option)
- `packages/sdk/src/worker.ts` (modify `close()` per finding #2: either call `workerRelease`, OR add one-line comment documenting what close() does NOT do)
- `packages/sdk/tests/hn-monitor-runner.test.ts` (create, with ALL required coverage)

**Addresses five findings from closed PR #83:**

1. **Fail-closed on journal errors.** Split error handling: `try { fetch } catch { onFetchError }` around network calls (swallowable), `try { eventSubmit } catch { rethrow }` around journal calls (MUST terminate runner).

2. **AgentWorker.close() completion.** Either add `workerRelease` verb to protocol.ts and call from `close()` (preferred), OR add one-line comment naming what `close()` intentionally does NOT do.

3. **Class field declaration order.** Declare ALL fields at top of class body, before constructor.

4. **Signal handlers opt-in via AbortSignal.** Accept `signal?: AbortSignal` in options; CLI wrapper (sub-PR C) wires process signals.

5. **Test coverage for pollError branch.** Add tests proving: loop survives fetcher throw AND loop TERMINATES on journal throw.

## Definition of Done

All of these, with literal command output pasted:

1. `packages/sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` class
2. Exported from `packages/sdk/src/index.ts`
3. `packages/sdk/src/worker.ts` — `close()` either calls `workerRelease` (with matching protocol.ts definitions if added), OR has one-line comment documenting what it does NOT do
4. `packages/sdk/tests/hn-monitor-runner.test.ts` covers ALL of:
   - fake fetch + mock journal client → runner submits event on each tick
   - abort signal triggers clean shutdown within one tick (worker released or documented)
   - worker attach happens BEFORE first poll
   - **fetch throw → loop survives** (onPollError called, next tick runs)
   - **journal throw → loop TERMINATES** (runner.run() rejects with error)
5. EVERY new test confirmed to FAIL against current code (comment out source, paste literal failing output)
6. `cd packages/sdk && npm test` — green, with literal output showing new tests passed
7. `git status --porcelain` — pasted as final action

## Out of Scope

DO NOT TOUCH:
- `.github/workflows/*` — no GHA changes
- `kernel/*` — kernel side already works (PR #14)
- `workflows/*.yaml` — for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this
- `ops/STATE.md` — gate-2 declaration is sub-PR D, separate PR
- CLI wrapper implementation — sub-PR C, separate PR
- Integration test with real relayflowd + fake HN fetch → assert step reaches `done` — sub-PR B, separate PR
- LLM review calls — runner is glue, not a reviewer

## Blockers

None known. All primitives exist: `JournalClient`, `AgentWorker` (from PR #53), `pollHackerNewsOnce` from `hn-poller.ts`.
