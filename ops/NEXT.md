# NEXT — Gate 2 real analyzer execution

**Scope:** complete the real `hn-monitor` analyzer seam. CODE task,
TypeScript/testdata side. **Route to a Claude Code product seat; Codex seats
may assess or review this package but must not author the product code.**

This package is pinned to **RFC-0001 gate 2 — proactive agent**. Gate 3 means
Software Garden; do not reuse the obsolete “worker protocol = gate 3”
numbering.

## Objective

Make the real `hn-monitor` workload complete its `analyze-story` agent step
successfully through the merged kernel + SDK worker path.

## Merged prerequisites — do not redo

- PR #14 (`2ac0d50`) and PR #15 (`079f7c4`): event wake, wake-context
  journaling, and duplicate-event suppression (`deduped` + no second run).
- PR #53 (`9681f11`): exported `AgentWorker` and live agent-step completion.
- PR #120 (`201542a`): unattended `flows hn-monitor start` runner.
- PR #122 (`a774d88`): trigger-plane liveness sweep.
- PR #124 (`3855099`): object-shaped CLI JSON becomes verification input.
- PR #125 (`7b115bd`): `RELAYFLOW_WAKE_CONTEXT` reaches the declared CLI and
  is pinned by positive/negative live-kernel tests.

## The remaining gap

`testdata/hn-monitor.flow.yaml` declares the `analyze-story` agent step and
its JSON schema but no real CLI. The merged live run in PR #121 (`5835cba`)
therefore ended each analyzer attempt as `worker_error`. The worker and trigger
planes are present; the real analyzer program is not.

Use the detailed existing package at
`ops/factory/briefs/hn-monitor-real-cli.md` as the implementation scope.

## Definition of done

1. A declared, authenticated real analyzer CLI consumes
   `RELAYFLOW_WAKE_CONTEXT` and emits exactly one valid JSON object with
   `story_title`, `relevance_score`, and `reasoning`.
2. A live `relayflowd` integration attaches `AgentWorker` before submitting
   the HN event, observes `analyze-story` reach `done`, and asserts the
   promoted output passes the canonical schema.
3. The live acceptance evidence actually executes the analyzer. A visible
   auth-based test skip is useful diagnostics but is not acceptance evidence.
4. The worker adds no retry, scheduling, dedupe or lease logic; those remain
   kernel-owned.
5. The PR cites merged commits, literal verification commands and captured
   output. Every new test has literal fail-first evidence.
6. No Gate-3/Garden work, gate flip, deploy, merge or production promotion.

## Explicit non-goals

- Reimplementing wake context, duplicate-event suppression, trigger liveness,
  or `AgentWorker`.
- Editing `kernel/`.
- Claiming Gate 2 GREEN from a fixture-only or auth-skipped test.
- Starting this package from the assessment run that authored this file.
