# NEXT — Gate 3: harden the Garden's loop with path validation

**This run is pinned to gate 3.**

## Scope

From ops/TARGET.md:
> (b) The consumer accepts any package whose fields are present. It does not check that files_in_scope names paths that EXIST, so a package can be accepted while scoping files that are not there. Add that check as a new typed refusal reason, with tests.

The work-package-consumer (`sdk/src/work-package-consumer.ts`) validates that a package has:
- a non-empty title
- a non-empty files_in_scope array
- a non-empty definition_of_done array

But it does NOT check whether the paths in files_in_scope actually exist. A package scoping `["nonexistent-dir/", "missing.ts"]` passes validation and gets admitted as runnable work, even though executing it would fail when trying to access those files.

## Objective

Add path existence validation to the work-package consumer. A package scoping files that do not exist should be refused with a new typed refusal reason: `nonexistent_files_in_scope`.

## Files in scope

- `sdk/src/work-package-consumer.ts` — add the existence check and the new refusal reason
- `sdk/src/index.ts` — export the new refusal reason if needed
- `sdk/tests/work-package-consumer.test.ts` — add tests for the new validation

## Definition of done

1. A new typed refusal reason `nonexistent_files_in_scope` is added to `WorkPackageRefusalReason`
2. `consumeWorkPackage()` accepts an optional `cwd` parameter (defaults to `process.cwd()`) for path resolution
3. When any path in `files_in_scope` does not exist relative to `cwd`, the package is refused with reason `nonexistent_files_in_scope`
4. Tests cover:
   - refusing a package with one nonexistent file
   - refusing a package with all nonexistent files
   - accepting a package where all files exist
   - the new test CONFIRMED TO FAIL against current code before the fix
5. All existing tests still pass
6. `cd sdk && npm test` green

## Verification commands

BEFORE implementing the fix, write the test and confirm it FAILS:
```
cd sdk && npm test -- work-package-consumer.test.ts 2>&1 | grep -A5 "nonexistent"
```

AFTER implementing the fix:
```
cd sdk && npm test
```

Expected: all tests pass, including the new nonexistent-files tests.

## Out of scope

- Option (a) from TARGET.md — malformed backlog entry handling (picker-side)
- Any kernel/ changes
- Any ops/ changes beyond this file
- Any testdata/ changes
- `sdk/src/demo-hn-monitor.ts`

## Final verification

As the LAST action before finishing:
```
git status --porcelain
```

Paste the literal output.
