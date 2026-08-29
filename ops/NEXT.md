# NEXT — Gate 3: Validate files_in_scope exist

**Gate 3, option (b) from ops/TARGET.md scope.**

The picker→consumer loop is complete (PR #23 merged). What it does NOT do is survive a work package that scopes files that don't exist. Per TARGET.md: "The consumer accepts any package whose fields are present. It does not check that files_in_scope names paths that EXIST, so a package can be accepted while scoping files that are not there. Add that check as a new typed refusal reason, with tests."

## Objective

Harden the work package consumer by validating that every path in `files_in_scope` actually exists in the filesystem before accepting the package. A package scoping nonexistent files cannot be executed, so it must be refused with a typed reason rather than accepted.

## Scope (quoted from ops/TARGET.md)

"(b) The consumer accepts any package whose fields are present. It does not check that files_in_scope names paths that EXIST, so a package can be accepted while scoping files that are not there. Add that check as a new typed refusal reason, with tests."

## Files in scope

- `sdk/src/work-package-consumer.ts` — add validation logic and new refusal reason
- `sdk/src/index.ts` — export new refusal reason if added to the type
- `sdk/tests/work-package-consumer.test.ts` — tests for the new behavior
- NO changes to `kernel/`
- NO changes to `sdk/src/demo-hn-monitor.ts`
- NO changes to `ops/`

## Definition of done

1. New typed refusal reason `nonexistent_files` added to `WorkPackageRefusalReason` type
2. `consumeWorkPackage` checks that each path in `files_in_scope` exists (file or directory) before accepting
3. Tests added covering:
   - Package refused when files_in_scope contains a nonexistent file path
   - Package refused when files_in_scope contains a nonexistent directory path
   - Package accepted when all files_in_scope paths exist (both files and directories)
   - Existing consumer tests still pass (no regression)
4. **EVERY new test CONFIRMED TO FAIL against current code** with literal failing output quoted
5. After implementation, `cd sdk && npm test` passes:
   ```
   cd sdk && npm test
   ```
   Paste the literal output showing all tests green, 0 failed
6. As the LAST action, run and paste:
   ```
   git status --porcelain
   ```

## Out of scope

- Malformed backlog entries (TARGET.md option a — different work package)
- Any picker changes
- Integration or scheduling changes
- Any work beyond the single validation check described above
