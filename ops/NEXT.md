# NEXT — Gate 3: Harden backlog picker against malformed entries

**Pinned to gate 3** per ops/TARGET.md.

## Objective

The picker reads ops/BACKLOG.md and selects the first bold top-level bullet. Currently it handles well-formed entries but a malformed entry — a bold title with no body, an unterminated backtick, a bullet nested under another — can crash or produce a half-formed package. Add handling so malformed entries produce typed refusals, never crashes and never half-formed packages.

## Scope from ops/TARGET.md

> The picker reads whatever ops/BACKLOG.md contains. A malformed entry — a
> bold title with no body, an unterminated backtick, a bullet nested under
> another — should produce a typed refusal, never a crash and never a
> half-formed package. Add the handling and the tests.

Note: The consumer's file existence check (option b) is ALREADY implemented in sdk/src/work-package-consumer.ts:52-55 with the 'nonexistent_files' refusal reason. This work package implements option (a).

## Files in scope

- sdk/src/backlog-picker.ts — add validation and typed refusal reasons
- sdk/tests/backlog-picker-flow.test.ts — tests for malformed entry handling
- sdk/src/index.ts — export new refusal types if needed

## Definition of done

1. Code added to sdk/src/backlog-picker.ts that validates entries and returns typed refusal reasons
2. Tests covering malformed cases: bold title with no body, unterminated backtick, nested bullet
3. Tests covering existing behavior still passing
4. Command passes:
   ```
   cd /project/workflows/runs/fec0723e-4bcb-4512-a599-fc61e110dfa6/sdk && npm test
   ```
5. EVERY new test confirmed to FAIL against current code with literal failing output quoted in summary
6. As LAST action, run and paste output:
   ```
   git status --porcelain
   ```

## Explicitly OUT of scope

- kernel/ changes
- sdk/src/demo-hn-monitor.ts
- anything under ops/
- the consumer's file existence check (already implemented in work-package-consumer.ts:52-55)
