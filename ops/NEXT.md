# NEXT — WP-GATE3-CONSUMER: Work Package Consumer

**Target gate:** Gate 3 (per ops/TARGET.md — this run is pinned to gate 3 only)

**Work package:** Build `sdk/src/work-package-consumer.ts` — the missing piece that judges work packages proposed by `sdk/src/backlog-picker.ts`

## Objective

TARGET.md quotes:
> Continue the highest-value next step. Read ops/STATE.md for gate truth and open PRs, and ops/BACKLOG.md for known defects, then pick ONE small thing and do it. Prefer: closing a defect the backlog already names with evidence; extending gate 3's Garden (sdk/src/backlog-picker.ts proposes work, sdk/src/work-package-consumer.ts judges it — the loop between them is thin); or hardening something that has failed before.

The Garden loop is: **picker proposes, consumer judges**. PRs #20, #21, #22 delivered the picker. The consumer does not exist yet. This is the next step.

## Current state

From ops/STATE.md:
- Gate 3 has `sdk/src/backlog-picker.ts` merged (PRs #20, #21, #22)
- `testdata/backlog-picker.flow.yaml` and its canonical spec exist
- Picker tests pass: `sdk/tests/backlog-picker.test.ts` and `sdk/tests/backlog-picker-flow.test.ts`
- SDK tests have 19 pre-existing failures (NOT related to gate 3 work — these are in cli.test.ts and bin.test.ts)
- work-package-consumer.ts does NOT exist yet

## Files in scope

**New files to create:**
- `sdk/src/work-package-consumer.ts` — judgement function that validates work package structure
- `sdk/tests/work-package-consumer.test.ts` — tests for the consumer

**Files to modify:**
- `sdk/src/index.ts` — export the new work-package-consumer module

## Definition of done

Per TARGET.md:
> Definition of done: code plus tests, 'cd sdk && npm test' green, and EVERY new test confirmed to FAIL against current code with its literal output in your summary. As your LAST action run 'git status --porcelain' and paste it.

1. **Code exists:** `sdk/src/work-package-consumer.ts` with a validation/judgement function
2. **Tests exist and FAIL first:** `sdk/tests/work-package-consumer.test.ts` tests that are CONFIRMED TO FAIL before the consumer exists (literal failure output captured)
3. **Tests pass after implementation:** New tests pass after consumer is built
4. **SDK suite status unchanged:** The 19 pre-existing test failures remain the same count (we don't break more)
5. **Literal evidence required:**
   - Command: `npm test` (from sdk/) — full output showing test results
   - Command: `git status --porcelain` — full output showing changed files

## Implementation approach

The consumer should validate that a work package has required structure:
- Required fields present (title, description, files, etc.)
- Valid format (non-empty strings, arrays where expected)
- Sensible constraints (e.g., scope not empty)

Keep it simple: validation logic that returns pass/fail with reasons.

## Explicitly OUT of scope

Per TARGET.md:
> Do NOT touch kernel/relayflowd/src/server.rs or sdk/src/demo-hn-monitor.ts.

- kernel/relayflowd/src/server.rs (forbidden)
- sdk/src/demo-hn-monitor.ts (forbidden)
- Opening PRs (Lead opens PRs, not this step)
- Fixing the 19 pre-existing SDK test failures
- Any work on gates other than gate 3
- Backlog defects (not highest value right now)

## Why this is the right work package

1. **TARGET.md explicitly names it:** "sdk/src/backlog-picker.ts proposes work, sdk/src/work-package-consumer.ts judges it — the loop between them is thin"
2. **Next logical step:** Picker exists (merged), consumer does not
3. **Small and achievable:** One module + tests, ~10 minutes
4. **Extends gate 3's Garden:** Completes the propose→judge loop foundation
