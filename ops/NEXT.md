# NEXT — Consumer validates files_in_scope paths exist

## Target scope (from gate 3)

**Scope:** Harden the Garden's loop with a case it does not yet handle. CODE task, SDK-side.

On main now, all merged and tested:
  - `sdk/src/backlog-picker.ts` — proposes a work package from ops/BACKLOG.md
  - `sdk/src/work-package-consumer.ts` — judges one, refusing with a typed
    reason (missing_title / missing_scope / missing_definition_of_done)
  - `testdata/backlog-picker.flow.yaml` — the flow, with its canonical spec
  - a test running the flow's real emit-package output through the consumer,
    proving the two halves interoperate in both directions

So propose -> judge -> accept/refuse works end to end. What it does NOT do is
survive a hostile or malformed backlog. Pick ONE of these and do it properly:

  (a) The picker reads whatever ops/BACKLOG.md contains. A malformed entry — a
      bold title with no body, an unterminated backtick, a bullet nested under
      another — should produce a typed refusal, never a crash and never a
      half-formed package. Add the handling and the tests.

  (b) The consumer accepts any package whose fields are present. It does not
      check that files_in_scope names paths that EXIST, so a package can be
      accepted while scoping files that are not there. Add that check as a new
      typed refusal reason, with tests.

**Decision:** Implementing option (b) — files_in_scope path existence validation.

## Objective

Add a new refusal reason to `work-package-consumer.ts` that rejects packages
scoping nonexistent files. A package accepted today while naming files that do
not exist (`sdk/src/does-not-exist.ts`) must be refused with a typed reason
(`nonexistent_files`).

## Files in scope

- `sdk/src/work-package-consumer.ts`
- `sdk/tests/work-package-consumer.test.ts`
- `sdk/src/index.ts` (if new types need export)

## Definition of done

1. **New typed refusal reason** `nonexistent_files` added to
   `WorkPackageRefusalReason` type
2. **Path existence check** in `consumeWorkPackage` that refuses when
   files_in_scope contains paths that do not exist on disk
3. **Tests covering the new behavior:**
   - Test: refuse a package with all nonexistent files
   - Test: refuse a package with a mix of existent and nonexistent files
   - Test: accept a package with all existent files
4. **EVERY new test confirmed to FAIL against current code** — the literal
   failing output must be quoted below when reporting BUILD_DONE
5. **Existing tests still passing** — all 8 existing work-package-consumer tests
   green
6. **Full SDK suite passing:**
   ```
   cd sdk && npm test
   ```
   Must show green suite with exact pass count.
7. **As the LAST action, run and paste:**
   ```
   git status --porcelain
   ```

## Out of scope

- Picker malformed-entry handling (option a) — that is NOT this run's target
- Checking that files are readable, only that they exist
- Recursively resolving directory globs — check the literal path only
- Any changes to kernel/, testdata/, or ops/
- Any changes to sdk/src/demo-hn-monitor.ts
