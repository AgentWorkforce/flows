# NEXT — work package for this tick

**Gate:** 3 (as specified in ops/TARGET.md)

**Scope (quoted from TARGET.md):**

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

**Objective:** Implement `sdk/src/hn-monitor-runner.ts` — a continuous polling runner that composes existing pieces (JournalClient, AgentWorker, hn-poller) into a gate-2 workload. This is sub-PR A: scaffolding that proves assembly, NOT end-to-end execution (that's sub-PR B).

**Context:** PR #83 attempted this and was closed on five real findings. This attempt addresses all five:

1. Fail-closed on journal errors: fetch errors may be swallowed; journal write failures MUST throw
2. `AgentWorker.close()` must release the worker (add `workerRelease` verb) or explicitly document it does not
3. Class field declarations before constructor
4. Signal handlers opt-in via AbortSignal (not process-global)
5. Test coverage for pollError branch (loop survives fetch throw; loop TERMINATES on journal throw)

**Files in scope:**

- `sdk/src/hn-monitor-runner.ts` (new) — the runner implementation
- `sdk/src/worker.ts` — either add `workerRelease` call to `close()` OR add one-line comment on what close() intentionally does NOT do
- `sdk/src/protocol.ts` — if adding `workerRelease` verb, add request/response definitions
- `sdk/tests/hn-monitor-runner.test.ts` (new) — all five test cases pinned
- `sdk/src/index.ts` — export `HnMonitorRunner`

**Definition of done (all required):**

1. `sdk/src/hn-monitor-runner.ts` exists and exports `HnMonitorRunner`
2. Runner constructs JournalClient, attaches AgentWorker BEFORE first poll
3. Poll loop: `pollHackerNewsOnce` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000) → repeat
4. Clean exit on AbortSignal.abort (drain in-flight, close client, release worker per finding #2)
5. `sdk/src/worker.ts` — either `close()` calls `workerRelease` OR has one-line comment on what it intentionally does NOT do
6. `sdk/src/protocol.ts` — if `workerRelease` added, matching request/response definitions present
7. `sdk/tests/hn-monitor-runner.test.ts` covers ALL cases:
   - fake fetch + mock journal → runner submits event on each tick
   - abort signal triggers clean shutdown within one tick
   - worker attach happens before first poll
   - **fetch throw → loop survives** (onPollError called, next tick runs)
   - **journal throw → loop TERMINATES** (runner.run() rejects with error)
8. EVERY new test CONFIRMED TO FAIL against current code (comment out the source; test fails; paste literal failing output)
9. `npm test` in sdk/ — output pasted, green
10. Exported from `sdk/src/index.ts`

**Explicit non-goals for THIS tick (DO NOT DO):**

- End-to-end integration test with real relayflowd (sub-PR B, separate PR)
- CLI wrapper (`flows hn-monitor start`) (sub-PR C, separate PR)
- ops/STATE.md gate-2 declaration (sub-PR D, separate PR)
- `.github/workflows/*` — no GHA changes
- `kernel/*` — kernel side already works via PR #14
- `workflows/*.yaml`
- `ops/AUTODRIVE_BRIEF.md`
- Any file outside `sdk/src/` and `sdk/tests/`

**Blockers:** None identified. All primitives exist:
- `sdk/src/hn-poller.ts` — the poller
- `sdk/src/worker.ts` — AgentWorker
- `sdk/src/journal-client.ts` — JournalClient
- `testdata/hn-monitor.flow.yaml` — canonical spec

**Next steps:**

1. Read existing files: `sdk/src/worker.ts`, `sdk/src/protocol.ts`, `sdk/src/hn-poller.ts`, `sdk/src/journal-client.ts`
2. Implement `sdk/src/hn-monitor-runner.ts` addressing all five findings
3. Add/update `workerRelease` in protocol/worker per finding #2
4. Write comprehensive tests in `sdk/tests/hn-monitor-runner.test.ts`
5. Verify each test FAILS against current code (mutation testing)
6. Run `npm test` and paste output
7. Export from `sdk/src/index.ts`
8. Run `git status --porcelain` and paste output

**Success criteria:** All tests green, all five findings addressed, every test proven to fail without its implementation, ready for PR review by the swarm.
