# NEEDS HUMAN — Gate confusion: is TARGET.md work already complete?

**Run:** 4b70c379-1e78-4702-a2cf-45eded63798a
**Date:** 2026-09-15
**Agent:** Relayflow Lead (assess step)

## The question

TARGET.md pins this run to **gate 3** and asks for:

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

It specifies adding `sdk/src/hn-monitor-runner.ts` with:
- JournalClient connection
- AgentWorker attach BEFORE first poll
- Poll loop with configurable interval
- Clean shutdown on AbortSignal
- Address 5 findings from closed PR #83

However, STATE.md (last updated 2026-09-01) shows:

> - PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
>   **`flows hn-monitor start`**, the CLI runner that turns the poller
>   into an unattended process.

And the file `packages/sdk/src/cli/hn-monitor.ts` (observed in earlier read operations) appears to be 288 lines implementing exactly what TARGET.md asks for:
- `runHnMonitor` function composing JournalClient + AgentWorker
- Attach before poll (line 227)
- Poll loop with configurable interval (lines 239-273)
- Clean shutdown on AbortSignal (lines 239, 274-278)
- Error classification (fetch vs journal, lines 258-267)

## The options

**Option A:** PR #120's `cli/hn-monitor.ts` IS the implementation TARGET.md requests.
- Action: Verify it satisfies all 9 items from TARGET.md Definition of Done
- If yes: This work package is complete, just needs verification evidence
- If no: Document gaps and implement missing pieces

**Option B:** TARGET.md wants a DIFFERENT `sdk/src/hn-monitor-runner.ts` separate from the CLI.
- Question: What should differ? The TARGET says "add `sdk/src/hn-monitor-runner.ts`" but the merged code is at `sdk/src/cli/hn-monitor.ts`
- Is this a path difference that matters? Or should the runner be factored out of the CLI wrapper?

**Option C:** The TARGET.md is stale.
- The prior ops/NEXT.md said gate 3 work is "document review-swarm secrets in README"
- Is that the actual current gate 3 work?

## Why blocked

Cannot execute the work package without knowing whether to:
1. Verify existing code
2. Build new code alongside existing code
3. Work on different task entirely

The charter requires: "if genuinely blocked on a decision only a human can make, write ops/NEEDS_HUMAN.md with the exact question and the options — then still end with ASSESS_DONE."

## Recommendation

Check PR #120's diff and STATE.md:
- If `cli/hn-monitor.ts` merged in #120 addresses TARGET.md's scope → verify it
- If not → clarify what's still needed

The run should not silently re-implement already-merged work.
