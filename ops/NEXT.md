# NEXT — Work package for this tick

**Gate**: 3 (as specified in ops/TARGET.md)

## Scope (quoted from TARGET.md)

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt.

## Assessment

After reviewing the codebase, I found that `sdk/src/cli/hn-monitor.ts` already exists and contains `runHnMonitor()` — a complete, functional hn-monitor runner that addresses all 5 findings from PR #83:

1. ✅ **Fail-closed on journal errors**: Lines 253-268 separate fetch errors (caught as `HnTransientFetchError`, logged, loop continues) from journal errors (any other error terminates with exit code 1)
2. ✅ **Worker close() documented**: `worker.ts:31-37` documents that `close()` does NOT release the worker registration
3. ✅ **Field declaration order**: `worker.ts:40-42` declares all fields before constructor
4. ✅ **AbortSignal**: `hn-monitor.ts:59` accepts `signal?: AbortSignal` parameter
5. ✅ **Test coverage**: `tests/cli-hn-monitor.test.ts` exists

The CLI runner (`runHnMonitor`) in `cli/hn-monitor.ts`:
- Constructs JournalClient and connects (line 210)
- Attaches AgentWorker BEFORE first poll (line 227)
- Loops with pollHackerNewsOnce (line 254)
- Exits cleanly on abort signal (line 274-278 drain + close)
- Exported from index.ts already (checked)

PR #120 (`flows hn-monitor start`) merged on 2026-09-01 per STATE.md line 46-47.

## The confusion

TARGET.md asks to create `sdk/src/hn-monitor-runner.ts` but:
- The functional runner already exists in `sdk/src/cli/hn-monitor.ts` as `runHnMonitor()`
- It's already exported, tested, and merged
- All 5 findings from PR #83 are already addressed

TARGET.md says this is "sub-PR A" (the runner) separate from "sub-PR C" (CLI wrapper), but the implementation combines them in one file (`cli/hn-monitor.ts`), which is a valid design choice.

## Question for human decision

Two interpretations:

**A)** The work is already complete. PR #120 delivered the hn-monitor runner (`runHnMonitor` in `cli/hn-monitor.ts`), addressing all 5 findings. The TARGET.md request for a separate `hn-monitor-runner.ts` file was satisfied by integrating it into the CLI module instead. Gate 3 (as scoped for this run) is done.

**B)** Extract `runHnMonitor()` from `cli/hn-monitor.ts` into a new `sdk/src/hn-monitor-runner.ts` file to match TARGET.md's literal file structure requirement, even though the functionality already exists and works.

Interpretation A is more aligned with RFC-0001 covenant 2 (value delivered code over structure), but interpretation B is more literal to TARGET.md's specification.

## Recommendation

**Interpretation A is correct.** The work TARGET.md describes is already complete in PR #120. The fact that it lives in `cli/hn-monitor.ts` rather than a separate `hn-monitor-runner.ts` file is an implementation detail. The substance — a working hn-monitor runner that addresses all 5 findings — exists, is tested, and is merged.

However, if TARGET.md's file structure is a hard requirement (separate runner from CLI), that should be clarified by a human before proceeding.

## What should happen next

If interpretation A is correct, this run should SKIP this target (already done) and either:
- Retarget to a different gate 3 task, OR
- Report completion and let the executor handle the redundant assignment

If interpretation B is correct, create ops/NEEDS_HUMAN.md asking whether to refactor working, merged code to match a different file structure.

Given the charter's instruction that staying inside the target is mandatory, and the target appears to be already satisfied, I'm writing this as ops/NEEDS_HUMAN.md rather than starting work that may be redundant.
