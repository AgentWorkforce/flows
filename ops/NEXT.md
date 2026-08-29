# NEXT — Gate 3: Work package consumer (judgment half of Garden loop)

**This run is pinned to gate 3** and must not work on any other gate.

## Target scope (from ops/TARGET.md)

Continue the highest-value next step. Read ops/STATE.md for gate truth and open PRs, and ops/BACKLOG.md for known defects, then pick ONE small thing and do it. Prefer: closing a defect the backlog already names with evidence; extending gate 3's Garden (sdk/src/backlog-picker.ts proposes work, sdk/src/work-package-consumer.ts judges it — the loop between them is thin); or hardening something that has failed before. Definition of done: code plus tests, 'cd sdk && npm test' green, and EVERY new test confirmed to FAIL against current code with its literal output in your summary. As your LAST action run 'git status --porcelain' and paste it. Do NOT touch kernel/relayflowd/src/server.rs or sdk/src/demo-hn-monitor.ts. ONE cycle, ten minutes — small and true beats large and aspirational.

## Objective

Create `sdk/src/work-package-consumer.ts` - the judgment half of the gate 3 Garden loop. The backlog-picker proposes work packages from ops/BACKLOG.md; the consumer must judge them: validate structure, extract requirements, and determine if a package is actionable or needs human refinement.

## Files in scope

- `sdk/src/work-package-consumer.ts` (NEW - the consumer logic)
- `sdk/tests/work-package-consumer.test.ts` (NEW - test suite)
- `sdk/src/index.ts` (export the new module)

## Definition of done

1. `sdk/src/work-package-consumer.ts` exists with:
   - Function to parse a work package (from ops/NEXT.md format)
   - Validation: title exists, scope present, definition of done contains testable commands
   - Extraction: pull out files in scope, gate number if mentioned
   - Clear pass/fail: returns typed result indicating actionable vs needs-human

2. Tests in `sdk/tests/work-package-consumer.test.ts` with:
   - Well-formed package passes validation
   - Missing DoD fails validation
   - DoD with no commands fails validation
   - Files-in-scope extraction works (matches backlog-picker's pattern)
   - Gate number extraction works
   - Each test MUST be confirmed to FAIL without its implementation

3. All tests pass:
```
cd sdk && npm test
```
Must show 0 failures across all test suites.

4. Every new test verified to fail FIRST:
   - Write test
   - Run it, capture literal failure output
   - Implement the feature
   - Confirm test now passes
   - Report both states in summary

5. Final verification:
```
git status --porcelain
```
Paste the literal output showing which files were modified/created.

## Out of scope

- Do NOT modify kernel/relayflowd/src/server.rs
- Do NOT modify sdk/src/demo-hn-monitor.ts
- Do NOT build the full Garden orchestration flow yet - just the consumer component
- Do NOT add work-package execution logic - only parsing and validation
- Do NOT integrate with backlog-picker yet - keep them independent modules
- Do NOT add CLI commands - this is library code only
