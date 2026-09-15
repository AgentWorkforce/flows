# NEEDS_HUMAN — Target already satisfied, needs retargeting or clarification

**Run ID**: 730e0c56-2b43-47c5-b5d7-be129afe58dd

**Reported by**: Relayflow Lead (assess step)

**Date**: 2026-09-15

## The block

ops/TARGET.md pins this run to gate 3 and scopes it as:

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

TARGET.md specifies creating `sdk/src/hn-monitor-runner.ts` and addressing 5 findings from closed PR #83.

**Current state**: All requested functionality already exists in `sdk/src/cli/hn-monitor.ts` (PR #120, merged 2026-09-01 per STATE.md:46-47).

Evidence that TARGET.md's requirements are satisfied:

1. **Fail-closed on journal errors**: `cli/hn-monitor.ts:253-268` separates transient fetch errors (caught as `HnTransientFetchError`, logged, loop continues) from journal errors (any other error → exit 1, terminate)

2. **Worker close() release documentation**: `worker.ts:31-37` explicitly documents that `close()` does NOT release the worker registration

3. **Field declaration order**: `worker.ts:40-42` declares all fields before the constructor

4. **AbortSignal for signal handlers**: `cli/hn-monitor.ts:59` accepts `signal?: AbortSignal` in options; no process.on() registration in library code

5. **Test coverage for error branches**: `tests/cli-hn-monitor.test.ts` exists (file confirmed via Glob)

The runner functionality TARGET.md describes:
- Constructs JournalClient, connects, hello (`cli/hn-monitor.ts:210`)
- Attaches AgentWorker BEFORE first poll (`cli/hn-monitor.ts:227`, per TARGET.md requirement and gate-2 ordering constraint from STATE.md)
- Loops: pollHackerNewsOnce → sleep → repeat (`cli/hn-monitor.ts:254-272`)
- Drains on abort signal and closes cleanly (`cli/hn-monitor.ts:274-278`)

## The question

Should this run:

**Option A**: Report TARGET already satisfied. PR #120 delivered the substance; the file lives in `cli/hn-monitor.ts` rather than a standalone `hn-monitor-runner.ts`, which is a valid implementation choice. The work is DONE.

**Option B**: Extract `runHnMonitor()` from `cli/hn-monitor.ts` into a new `sdk/src/hn-monitor-runner.ts` file to match TARGET.md's literal file path specification, even though the functionality is complete and tested.

**Option C**: Retarget this run to a different gate 3 task. The original gate 3 task may have been different, and TARGET.md was mis-scoped or out-of-date.

## Why this blocks

The charter says:

> It is the operator's scoping decision and it overrides your own judgement about priority — several runs execute in parallel, each pinned to a different gate, and a run that wanders outside its target will collide with a sibling. Stay inside it or, if the target is genuinely unreachable from the current state, say so in ops/NEEDS_HUMAN.md rather than silently choosing different work.

The target is not unreachable, but it appears to be already reached. Starting redundant work (Option B) risks:
- Refactoring merged, working code for no functional gain
- Colliding with sibling runs if this gate's real work is elsewhere
- Wasting a run slot on restructuring instead of net-new capability

Option A (report complete) seems correct, but the charter also says "stay inside the target," which could mean "do the literal work even if redundant."

## Recommendation

**Option A** — the target is satisfied. PR #120 delivered a working hn-monitor runner that addresses all 5 findings from PR #83. The file structure difference (`cli/hn-monitor.ts` vs `hn-monitor-runner.ts`) is an implementation detail.

If the literal file path is a hard requirement, clarify that before I refactor working code.

If this run's real intent was a different gate 3 task, update TARGET.md or re-scope the run.

## What I did

- Assessed the repo per charter
- Read TARGET.md, STATE.md, DIRECTIVES.md (empty)
- Found all TARGET.md requirements already satisfied in PR #120
- Wrote ops/NEXT.md documenting the assessment
- Updated this NEEDS_HUMAN.md to formally block rather than proceeding with redundant work
- Committing this work package and ending with ASSESS_DONE per charter

## Next steps (human decides)

1. If Option A: close/cancel this run as "target already satisfied"
2. If Option B: confirm in writing that refactoring `cli/hn-monitor.ts` is desired, then I'll proceed
3. If Option C: provide a new TARGET.md or direct me to the actual gate 3 work

This is not a technical blocker — it's a scoping/coordination question that only a human can resolve.
