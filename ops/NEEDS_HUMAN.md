# NEEDS_HUMAN — TARGET.md gate 2/3 conflict and possible duplicate work

## The question

Is this run's target actually gate 3 or gate 2? And is the requested `HnMonitorRunner` class needed when `runHnMonitor` function already exists?

## The conflict

**TARGET.md header (line 1):** "TARGET — gate 3"

**TARGET.md scope (line 5):** "Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK."

These contradict. The instructions say "this run is pinned to gate 3" but the work described is explicitly gate 2 sub-PR A.

## The possible duplication

TARGET.md requests (lines 35-42, 58-60):
- Add `sdk/src/hn-monitor-runner.ts` exporting `HnMonitorRunner` **class**
- Worker attach before poll, loop poll → sleep, AbortSignal shutdown
- Fail-closed on journal errors (covenant 2, finding #1 from PR #83)

**This already exists** in `packages/sdk/src/cli/hn-monitor.ts` as `runHnMonitor()` **function**:
- Merged in PR #120 on 2026-09-01 (ops/STATE.md line 45)
- Worker attaches before poll (line 227: `await worker.attach()`)
- Loops poll → sleep with AbortSignal support (lines 239-273)
- Journal errors fail runner, fetch errors log+continue (lines 258-268, typed split via `HnTransientFetchError`)
- Shutdown drains worker (lines 274-278: `await worker.close(); client.close()`)
- Documents workerRelease absence (line 161-162 comment)

The difference: function in `cli/` vs class in `src/`.

## Evidence

```bash
$ ls packages/sdk/src/cli/hn-monitor.ts
packages/sdk/src/cli/hn-monitor.ts

$ grep "export.*function runHnMonitor" packages/sdk/src/cli/hn-monitor.ts
export async function runHnMonitor(args: HnMonitorArgs, io: CliIo): Promise<0 | 1> {

$ ls packages/sdk/src/hn-monitor-runner.ts
ls: cannot access 'packages/sdk/src/hn-monitor-runner.ts': No such file or directory

$ grep -c "HnMonitorRunner" packages/sdk/src/*.ts
0
```

From ops/STATE.md lines 45-46:
> PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) — **`flows hn-monitor start`**, the CLI runner that turns the poller into an unattended process.

That CLI runner IS `cli/hn-monitor.ts`.

## Why gate 2 is AMBER (not the runner)

ops/STATE.md lines 60-73 says gate 2 is AMBER because:
1. **Trigger plane liveness-checking** not implemented (kernel doesn't notice if poller stops)
2. **The analyze-agent step doesn't execute** (worker has no user-supplied handler)

Neither is about the runner implementation - #1 is a kernel feature, #2 is handler wiring.

## Options for resolution

**Option A:** TARGET.md is stale. The work is done as a function-based implementation. Mark this run complete or redirect to actual gate 3 work.

**Option B:** Class-based API is architecturally required. Refactor `runHnMonitor` function → `HnMonitorRunner` class, keep both (class in src/, function wrapper in cli/).

**Option C:** This run's true target is gate 3 (Software Garden/factory), not hn-monitor. The TARGET.md body is copy-paste error. Redirect to actual gate 3 work per ops/BACKLOG.md.

**Option D:** The function exists but doesn't satisfy TARGET.md Definition of Done because tests don't cover fetch-survives/journal-terminates branches. Add those tests to cli-hn-monitor.test.ts.

## What I cannot decide alone

The scoping discipline the instructions enforce says:
> "It is the operator's scoping decision and it overrides your own judgement about priority. Stay inside it or, if the target is genuinely unreachable, say so in ops/NEEDS_HUMAN.md rather than silently choosing different work."

I cannot determine:
1. Whether this run should work on gate 2 or gate 3
2. Whether function-based `runHnMonitor` satisfies the requirement or class-based `HnMonitorRunner` is mandatory
3. Whether I should implement a new class when equivalent logic exists

If Option B (class required): I can build `sdk/src/hn-monitor-runner.ts` as a class wrapping the existing primitives. But doing so without confirmation risks duplicating PR #120's work in a different shape.

If Option D (tests missing): I can add test coverage. But TARGET.md Definition of Done line 62 says `sdk/tests/hn-monitor-runner.test.ts` (not `cli-hn-monitor.test.ts`), implying a separate artifact.

## Recommendation

Clarify whether:
1. This run targets gate 2 or 3
2. Function implementation (done) vs class implementation (TARGET.md requests) preference
3. If class: should it replace function or coexist?

Then I can write an unambiguous work package.

