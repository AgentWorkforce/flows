# Tracking reconciliation — merged `main` at `7728565`

Date: 2026-09-02 06:14 UTC. Scope: assessment only; no product code.

## Verdict

The RFC and `charter/LEAD.md` agree with `ops/SCOREBOARD.md`: gate 2 is the
proactive-agent gate and gate 3 is the Software Garden. The prior
`ops/NEXT.md` used a different numbering scheme and sent this seat to work
that had already merged. It is superseded by the corrected package in this
change.

Two scoreboard rows are materially behind merged `main`:

| Row | Finding |
|---|---|
| Gate 2 | Still **AMBER**, but three gaps named across the stale scoreboard/state tracking are closed: duplicate-event suppression was already pinned by PRs #14/#15; trigger liveness landed in #122; wake context reaches the dispatched CLI in #125. The actual remaining product gap is different: the canonical `hn-monitor` step declares no CLI, and the live evidence in PR #121 records every analyzer attempt as `worker_error`. |
| Gate 3 | Still **AMBER**, but the row stopped at PR #20. PR #123 added the three-lens pre-swarm relayflow and PR #126 added a concurrent Claude authoring driver. These are Garden scaffolding only: #126 explicitly remains a markdown/bash claim loop rather than kernel-owned claims, so they do not satisfy the gate. |

Gate 1's state is unchanged, but its evidence text used drifting test counts
and omitted the deterministic race closure in PR #48. The scoreboard now
uses merged PR/commit identities instead.

## Evidence pinned to merged commits

```text
$ git rev-parse HEAD
7728565813c84691bd8a152812e02677cefba390

$ gh pr view 14 --json mergeCommit --jq .mergeCommit.oid
2ac0d500e4576728d32122ed43b59a8ea2b6d4a0
$ gh pr view 15 --json mergeCommit --jq .mergeCommit.oid
079f7c40411f98430f160f0c7ced197fdae1bb70
$ gh pr view 122 --json mergeCommit --jq .mergeCommit.oid
a774d880d236a59d19b262975d0ea5debd324cad
$ gh pr view 125 --json mergeCommit --jq .mergeCommit.oid
7b115bd6b12ecaffe8ecf99750e2df932298c064
$ gh pr view 126 --json mergeCommit --jq .mergeCommit.oid
7728565813c84691bd8a152812e02677cefba390
```

### Clause A — wake context: CLOSED for the proactive-agent seam

The scoreboard's phrase “RFC-0001 Appendix A wake-time context contract” is
imprecise: Appendix A defines the agent-step *starting-state* contract. The
Gate-2 question here is whether the triggering event reaches the dispatched
agent CLI.

PR #14 (`2ac0d50`) journals the triggering payload under
`subscription.matched.wake_context`. PR #125 (`7b115bd`) completes the SDK
side: `StepDispatchEvent` exposes `wake_context`, `AgentWorker` passes it as
`RELAYFLOW_WAKE_CONTEXT`, and the live-kernel positive test attaches a worker,
submits a distinctive event ID, waits for `done`, and asserts the CLI echoed
that ID. Its negative test separately pins that the variable is absent for a
non-event run. That closes this Gate-2 seam; it does not claim that PR #125
implements every rule in Appendix A.

Relevant merged lines:

```text
sdk/tests/live-kernel.test.ts:579  await worker.attach();
sdk/tests/live-kernel.test.ts:593  const outcome = await client.eventSubmit(spec, {
sdk/tests/live-kernel.test.ts:599  expect(await waitForStep(..., 'done'))
sdk/tests/live-kernel.test.ts:616  expect(...story_title).toBe(`echoed:${storyId}`)
```

### Clause B — a duplicate event does not double-execute: CLOSED

This was never missing from merged history. In PR #14 (`2ac0d50`),
`matching_event_wakes_once_with_fresh_context` submits the same event twice;
the second result must be both `deduped` and `run.is_none()`. PR #15
(`079f7c4`) repeats the same assertion against the real `hn-monitor` spec.
No second run is created, so there is no second step execution to count.

```text
kernel/relayflowd/tests/event_wake.rs:47  let second = engine.submit_event(spec, event, "test").unwrap();
kernel/relayflowd/tests/event_wake.rs:48  assert!(second.matched && second.deduped);
kernel/relayflowd/tests/event_wake.rs:49  assert!(second.run.is_none());

kernel/relayflowd/tests/hn_monitor_integration.rs:54  let duplicate = engine.submit_event(spec, event, "hn-webhook").unwrap();
kernel/relayflowd/tests/hn_monitor_integration.rs:55  assert!(duplicate.matched && duplicate.deduped);
kernel/relayflowd/tests/hn_monitor_integration.rs:56  assert!(duplicate.run.is_none());
```

### Trigger liveness: CLOSED after the prior state report

PR #122 (`a774d88`) adds `stale_after_ms`, the subscription registry and
sweep claims, `subscription.stale` journal entries, and the liveness
regression suite. This closes the liveness item still listed as absent in
`ops/STATE.md` and the PR #121 evidence transcript. `ops/STATE.md` is an
immutable drive path, so this assessment corrects the writable scoreboard
and leaves a stable citation here for its eventual human-owned refresh.

### What remains open on Gate 2

The canonical spec has an `agent` instruction and JSON-schema verification,
but no declared `cli` (`testdata/hn-monitor.flow.yaml:12-35`). The worker
therefore follows its explicit missing-CLI branch
(`sdk/src/worker.ts:91-94`) and reports `worker_error`. PR #121
(`5835cba`) records the real unattended run: all analyzer steps failed on
that branch. PRs #124 (`3855099`) and #125 (`7b115bd`) supply output promotion
and wake-context plumbing, but the real analyzer itself is still absent.

Gate 2 therefore remains **AMBER**. No gate flip is proposed.

## True next unit of work — propose, do not execute here

Route the existing `hn-monitor-real-cli` package to a Claude Code product
seat, as required by `BRIEF-0902b.md`:

1. Implement an authenticated real analyzer CLI that consumes
   `RELAYFLOW_WAKE_CONTEXT` and emits the canonical
   `story_title` / `relevance_score` / `reasoning` object.
2. Exercise it against a live `relayflowd`, with the worker attached before
   event submission, and capture the `analyze-story` step reaching `done`
   with schema-verified output.
3. Preserve kernel ownership of dedupe, leases and retry; do not rebuild the
   already-closed wake-context, duplicate-event or liveness clauses.

The detailed existing scope is
`ops/factory/briefs/hn-monitor-real-cli.md`. This assessment does not launch
it and does not treat an auth-skipped test as acceptance evidence.
