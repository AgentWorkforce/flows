# NEEDS_HUMAN — Packaging mismatch between TARGET.md and delivered code

## The Question

TARGET.md (gate 3 scoping document) requests `sdk/src/hn-monitor-runner.ts` as a CLASS exported from `sdk/src/index.ts`.

PR #120 (merged 2026-09-01) delivered `runHnMonitor()` FUNCTION CLI-inlined at `sdk/src/cli/hn-monitor.ts`, NOT exported from the SDK public API.

**All functionality requirements are satisfied:**
- ✅ Connects to relayflowd via JournalClient
- ✅ Attaches AgentWorker BEFORE first poll
- ✅ Loops: pollHackerNewsOnce → sleep → repeat
- ✅ Exits cleanly on AbortSignal
- ✅ Handles fetch errors as transient, journal errors as fail-closed
- ✅ All 5 PR #83 findings addressed
- ✅ Full test coverage at `sdk/tests/cli-hn-monitor.test.ts`
- ✅ Works end-to-end (`flows hn-monitor start`)

**The packaging differs:**

| Aspect | TARGET.md requests | PR #120 delivered |
|--------|-------------------|-------------------|
| Location | `sdk/src/hn-monitor-runner.ts` | `sdk/src/cli/hn-monitor.ts` |
| Form | `HnMonitorRunner` class | `runHnMonitor()` function |
| Export | Exported from `sdk/src/index.ts` | CLI-private, not exported |
| Tests | `sdk/tests/hn-monitor-runner.test.ts` | `sdk/tests/cli-hn-monitor.test.ts` |

Should working, tested, merged code be refactored purely for structural reasons?

## Option A: Refactor to match TARGET.md structure

Extract logic from CLI into separate module:
1. Create `sdk/src/hn-monitor-runner.ts` with `HnMonitorRunner` class
2. Export from `sdk/src/index.ts`
3. Update `sdk/src/cli/hn-monitor.ts` to use the class
4. Refactor tests from `cli-hn-monitor.test.ts` to `hn-monitor-runner.test.ts`

**Pros:**
- Matches TARGET.md specification exactly
- Makes runner reusable outside CLI context

**Cons:**
- Refactors working, tested code for structure, not behavior
- Risk of introducing bugs into merged functionality
- Increases API surface (new public export)

## Option B: Accept delivered form as satisfying the requirement

Document that the functional requirements are met; packaging differs.

**Pros:**
- No changes to working code
- Functionality complete, tests green
- CLI works as specified

**Cons:**
- Does not match TARGET.md's explicit structure request
- TARGET.md line 71 specifically warns about confusion

## The exact question

**Should the `runHnMonitor()` function delivered in PR #120 be refactored into a `HnMonitorRunner` class exported from `sdk/src/index.ts` to match TARGET.md's structure, or is the current function-based, CLI-inlined implementation acceptable?**

Choose A (refactor) or B (accept as-is).
