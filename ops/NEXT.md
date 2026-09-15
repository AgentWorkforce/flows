# NEXT — Gate 3 Sub-PR A: HN Monitor Runner Implementation

**Scope (quoting TARGET.md verbatim):**

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

**Context:**

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

## Objective

Add `sdk/src/hn-monitor-runner.ts` composing existing pieces into a continuous runner that:
- Constructs a `JournalClient` connected to running `relayflowd` socket
- Constructs an `AgentWorker` and calls `workerAttach()` for `agent` steps — attach BEFORE first poll
- Loops: `pollHackerNewsOnce(spec, sink)` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000ms) → repeat
- Exits cleanly on `AbortSignal.abort` (drain in-flight steps, close client, release worker)
- Exported from `sdk/src/index.ts`

## Files in scope

- `sdk/src/hn-monitor-runner.ts` — NEW FILE, the runner implementation
- `sdk/src/worker.ts` — MODIFY `close()` to call `workerRelease` OR add one-line comment naming what close() does NOT do
- `sdk/src/protocol.ts` — IF adding `workerRelease`, add request/response definitions
- `sdk/tests/hn-monitor-runner.test.ts` — NEW FILE, comprehensive test coverage
- `sdk/src/index.ts` — MODIFY to export `HnMonitorRunner`

## Prior Attempt (PR #83, closed)

Produced functional runner but rejected by swarm on five findings. Address them:

1. **Fail-closed on journal errors** — Split error handling: `try { fetch } catch { onFetchError }` around network call, `try { eventSubmit } catch { rethrow }` around journal call. Only fetch-level errors may be swallowed; journal write failure MUST throw and terminate.

2. **AgentWorker.close() must release worker or document it does not** — Either add `workerRelease` verb to `protocol.ts` and call from `close()` (preferred), OR add one-line comment on `close()` naming exactly what shutdown does NOT do.

3. **Class field declaration order** — Declare ALL fields at top of class body, before constructor. Never declare fields after constructor.

4. **Signal handlers opt-in via AbortSignal** — Accept `signal?: AbortSignal` in options; CLI wrapper (sub-PR C) creates process-signal-driven AbortController. Library must not register process-level handlers.

5. **Test coverage for pollError branch** — Assert loop survives fetcher throw AND loop TERMINATES on journal throw. Without both, someone regresses `onPollError` to no-op and tests still pass.

## Definition of done

1. `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`
2. `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR one-line comment names what close() does NOT do
3. `sdk/src/protocol.ts` — if `workerRelease` added, matching request/response definitions present
4. `sdk/tests/hn-monitor-runner.test.ts` covers ALL:
   - Fake fetch + mock journal client → runner submits event on each tick
   - Abort signal triggers clean shutdown within one tick (worker released or documented)
   - Worker attach happens before first poll
   - **Fetch throw → loop survives** (onPollError called, next tick runs)
   - **Journal throw → loop TERMINATES** (runner.run() rejects with error)
5. Tests pass:
   ```
   cd sdk && npm test
   ```
   Output must be pasted in full.
6. EVERY new test confirmed to FAIL against current code:
   - Comment out source
   - Test fails
   - Paste literal failing output
7. PR body explicitly names non-goals:
   - Test-actually-runs is sub-PR B
   - CLI is sub-PR C
   - Gate-2 declaration is sub-PR D
8. ops/NEXT.md says Gate 2, not Gate 3 (assessor on #83 confused itself)
9. As LAST action, run and paste:
   ```
   git status --porcelain
   ```

## Explicitly OUT of scope

- `.github/workflows/*` — no GHA changes
- `kernel/*` — kernel side already works via PR #14
- `workflows/*.yaml` — for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this
- CLI wrapper — sub-PR C, separate PR
- End-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR

## Assessment

**BLOCKED - NEEDS HUMAN DECISION**

The TARGET.md pins this run to gate 3 work, but the scope described is actually gate 2 completion work (hn-monitor runner). STATE.md shows:
- Gate 2 is AMBER - PR #120 already merged `flows hn-monitor start` CLI runner
- The CLI implementation at `packages/sdk/src/cli/hn-monitor.ts` appears to already exist and address all 5 findings from PR #83

**Question for human:**

Is `packages/sdk/src/cli/hn-monitor.ts` (288 lines, already merged in PR #120 per STATE.md) the implementation that TARGET.md is asking for? If so, this work package is already complete and should be verified rather than re-implemented.

OR

Does TARGET.md want a DIFFERENT `sdk/src/hn-monitor-runner.ts` separate from the CLI implementation? If so, what should differ between the two?

**Cannot proceed** without clarifying whether this is:
1. Verify existing PR #120 satisfies TARGET.md requirements
2. Build new `hn-monitor-runner.ts` distinct from existing `cli/hn-monitor.ts`
3. Different work entirely (current ops/NEXT.md says document review-swarm secrets)

Filed in ops/NEEDS_HUMAN.md per charter requirement.
