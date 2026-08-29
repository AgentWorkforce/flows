# NEXT — Gate 3: File existence validation in work package consumer

## Objective

This run is pinned to **gate 3**. The target from ops/TARGET.md states:

> **Scope:** Harden the Garden's loop with a case it does not yet handle. CODE task, SDK-side.
>
> On main now, all merged and tested:
>   - `sdk/src/backlog-picker.ts` — proposes a work package from ops/BACKLOG.md
>   - `sdk/src/work-package-consumer.ts` — judges one, refusing with a typed
>     reason (missing_title / missing_scope / missing_definition_of_done)
>   - `testdata/backlog-picker.flow.yaml` — the flow, with its canonical spec
>   - a test running the flow's real emit-package output through the consumer,
>     proving the two halves interoperate in both directions
>
> So propose -> judge -> accept/refuse works end to end. What it does NOT do is
> survive a hostile or malformed backlog. Pick ONE of these and do it properly:
>
>   (a) The picker reads whatever ops/BACKLOG.md contains. A malformed entry — a
>       bold title with no body, an unterminated backtick, a bullet nested under
>       another — should produce a typed refusal, never a crash and never a
>       half-formed package. Add the handling and the tests.
>
>   (b) The consumer accepts any package whose fields are present. It does not
>       check that files_in_scope names paths that EXIST, so a package can be
>       accepted while scoping files that are not there. Add that check as a new
>       typed refusal reason, with tests.

**I choose option (b)**: add file existence checking to the work package consumer.

The consumer currently validates that `files_in_scope` is a non-empty string array, but it does NOT verify that those paths actually exist. A package scoping nonexistent files can be accepted and will fail later when work begins. Add a typed refusal reason `nonexistent_files` with tests.

## Files in scope

- `sdk/src/work-package-consumer.ts` — add file existence validation
- `sdk/tests/work-package-consumer.test.ts` — add tests for the new behavior
- `sdk/src/index.ts` — if needed to export new types

## Definition of done

All of the following must hold, per the target:

1. **Code in sdk/src** that checks every path in `files_in_scope` exists
2. A new typed refusal reason `nonexistent_files` added to `WorkPackageRefusalReason`
3. **Tests covering the new behavior AND existing behavior still passing**:
   - A package with all existing files → accepted
   - A package with one nonexistent file → refused with `nonexistent_files`
   - A package with multiple nonexistent files → refused with `nonexistent_files`
   - A package mixing existing and nonexistent files → refused with `nonexistent_files`
4. **Every new test confirmed to FAIL against current code**, with the literal failing output quoted
5. The following command passes:

```bash
cd sdk && npm test
```

Paste the complete literal output showing green tests.

6. **As the LAST action**, run and paste:

```bash
git status --porcelain
```

This makes any silent file loss visible immediately in the log.

## Out of scope

- Do NOT touch kernel/
- Do NOT touch sdk/src/demo-hn-monitor.ts
- Do NOT touch anything under ops/
- Do NOT implement option (a) from the target (malformed backlog handling)
- Do NOT work on any other gate

The target says: "ONE cycle, about ten minutes. Small and true beats large and aspirational."
