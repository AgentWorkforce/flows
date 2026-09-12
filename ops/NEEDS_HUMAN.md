# NEEDS_HUMAN — SDK build broken, blocks gate-2 work

**Question:** Should this run fix the SDK build errors before implementing the hn-monitor-runner, or is fixing the SDK infrastructure a separate work package?

**Context:** The gate-2 target is clear, scoped, and reachable: build `sdk/src/hn-monitor-runner.ts` that composes the existing HN poller + journal client + agent worker into a continuous polling service. All primitives exist (worker.ts from PR #53, hn-poller.ts, journal-client.ts, demo-hn-monitor.ts). The five findings from the rejected PR #83 are specific and actionable.

**The blocker:** The SDK won't compile at HEAD. TypeScript fails with 16 errors from missing exports in `@relayflows/surface`. Literal output:

```
$ cd /project/workflows/runs/21fe65da-df8e-4a5c-baa7-0238c6d939b7/packages/sdk
$ npm ci
[succeeds]
$ npm test
npm error code 2
npm error command sh -c npm run build

src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
src/helper-writeback.ts(5,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,42): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'invokeHelper'.
src/helper-writeback.ts(5,61): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/preflight.ts(7,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/slack-preflight.ts(3,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/slack-writeback.ts(3,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
src/trigger-executor.ts(1,10): error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
src/trigger-executor.ts(1,30): error TS2305: Module '"@relayflows/surface"' has no exported member 'webhook'.
src/trigger-executor.ts(1,44): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/trigger-executor.ts(1,64): error TS2305: Module '"@relayflows/surface"' has no exported member 'WebhookFilter'.
[plus 5 more implicit-any and type errors]
```

These SDK source files import the missing members:
- `src/helper-writeback.ts`
- `src/preflight.ts`
- `src/slack-preflight.ts`
- `src/slack-writeback.ts`
- `src/trigger-executor.ts`

Additional observation: `packages/surface/` directory does not exist in this worktree. The `packages/surface/package.json` is present (declaring @relayflows/surface 2.0.8), but `packages/surface/src/` is absent. This is a snapshot environment per STATE.md §"Known environment faults" — `.git` points to a detached worktree. The surface package source may not have been synced.

**The options:**

**A. Fix the surface package in THIS run, then proceed with the runner.**
- Scope: Investigate why surface/src/ is missing, regenerate or restore it, add the missing exports, verify SDK builds, THEN implement hn-monitor-runner.ts per TARGET.
- Rationale: The SDK must compile before any gate-2 code can be added.
- Risk: If surface is mid-refactor (exports intentionally removed), this conflicts with that work.
- Risk: May be outside gate-2 scope (SDK infrastructure vs. the runner itself).

**B. Report blocked, let a human or sibling run fix the SDK build.**
- Scope: This NEEDS_HUMAN.md file, ops/NEXT.md documenting the work package, commit both, end with ASSESS_DONE.
- Rationale: The SDK build is broken for reasons unrelated to the hn-monitor-runner. Fixing surface exports is a prerequisite work package, not part of building the runner.
- Risk: No forward progress on gate 2 until the SDK compiles.

**C. Stub out the failing SDK files to make it build, then add the runner.**
- Scope: Comment out or no-op the five broken imports (helper-writeback, preflight, slack-*, trigger-executor), verify SDK builds and core tests pass, THEN add hn-monitor-runner.ts.
- Rationale: The runner likely doesn't use helper writeback or trigger-executor; tests may pass with those stubbed.
- Risk: A stub is not a fix — the SDK can't be published or used outside this narrow path.
- Risk: If those files ARE required (e.g., preflight called during JournalClient setup), tests fail for the wrong reason.

**Recommendation:** Option B.

The SDK build is broken at HEAD for reasons outside the gate-2 work package. The errors are in EXISTING SDK files importing from `@relayflows/surface`, not in code this run would write. STATE.md and DRIVE-LOG.md mention no recent surface refactor, but the missing src/ directory and the import errors suggest one is in progress or incomplete.

Fixing surface exports or restoring surface/src/ is a prerequisite work package. This run was scoped to build the hn-monitor-runner, not to repair SDK infrastructure or investigate missing package directories in a snapshot environment.

**Next step if option B chosen:** A human or the next assess step should either:
1. Restore packages/surface/src/ to this worktree (if it's a sync issue), OR
2. Fix @relayflows/surface to re-export the missing members, OR
3. Update the SDK to stop importing them (if they were intentionally removed), OR
4. Declare gate-2 work blocked until a surface refactor completes.

**Evidence the blocker is environmental, not target-related:**
- `npm test` fails BEFORE any new code is added.
- The errors are in SDK files unrelated to the hn-monitor-runner (helper writeback, slack integration, trigger executor).
- The runner's dependencies (JournalClient, AgentWorker, hn-poller) don't import from surface/runtime.
- The surface package source directory is absent from the worktree entirely.
