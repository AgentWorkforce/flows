# NEXT — Gate 3: Sharpen backlog-picker actionability

**Scope:** Gate 3 — Improve how the Garden decides what is WORTH working on. CODE task, SDK-side.

On main now, all merged and tested:
- `sdk/src/backlog-picker.ts` — proposes a work package from ops/BACKLOG.md; exports selectBacklogEntry / packageFromEntry / validateWorkPackage
- `sdk/src/work-package-consumer.ts` — judges one, refusing with a typed reason (missing_title / missing_scope / missing_definition_of_done / nonexistent_files)
- `testdata/backlog-picker.flow.yaml` — the flow. Its `select-entry` step now scans for the first ACTIONABLE entry, validating candidates and skipping the ones that fail, and exits nonzero with NO_ACTIONABLE_BACKLOG_ENTRY when nothing qualifies.

Do NOT re-do any of the above. Malformed-backlog handling (PR #30) and the nonexistent-files check (PR #28) are DONE and merged.

## The actual defect

Run `select-entry` against the real ops/BACKLOG.md. It prints:

    SKIPPED_UNACTIONABLE=10 ...

and then selects a dated notes blob ("Upstream issues (2026-08-27):") as the work package. Ten genuine engineering tasks were skipped in favour of a list of links.

The cause: `validateWorkPackage` decides "actionable" using only two shallow signals — does the text contain a backticked path, and does it contain a multi-word backticked phrase. A notes blob full of backticked identifiers passes both. A real task written in prose ("Refuse a path-like deterministic command word when that path does not exist") fails both.

The guard is correct. The SELECTION is poor. That is what to fix.

## Objective

Implement a sharper notion of actionability in `sdk/src/backlog-picker.ts` so that the backlog picker selects real engineering tasks and does NOT select notes entries.

## Files in scope

- `sdk/src/backlog-picker.ts` — improve actionability detection
- `sdk/src/index.ts` — wire in new export if it is needed
- Tests for the new behavior
- `testdata/backlog-picker.flow.yaml` — ONLY if changes needed
- `testdata/backlog-picker.spec.canonical.json` — regenerate ONLY if yaml changes

## Definition of done

All of the following must hold:

1. **Improved actionability logic** in `sdk/src/backlog-picker.ts` that distinguishes real engineering tasks from notes blobs

2. **Literal before/after evidence:**
   - Quote the literal `select-entry` output BEFORE the change showing it selected "Upstream issues"
   - Quote the literal `select-entry` output AFTER the change showing it selected a real engineering task

3. **Test coverage:**
   - Tests covering the new behavior
   - EVERY new test confirmed to FAIL against current code (quote the literal failing output)
   - All existing tests still passing

4. **Green test suites:**
   ```
   cd sdk && npm test
   cd kernel && sh ../ops/cargo.sh test
   ```
   Both must pass with output quoted.

5. **If testdata/backlog-picker.flow.yaml is modified:**
   - Regenerate `testdata/backlog-picker.spec.canonical.json`

6. **Final verification** — as the LAST action, run:
   ```
   git status --porcelain
   ```
   And paste the output

## Out of scope

- **DO NOT re-implement malformed-backlog handling** (PR #30, merged)
- **DO NOT re-implement nonexistent-files check** (PR #28, merged)
- Any work on other gates (1, 2, 4, 5, 6, 7, 8, 9)
- Any changes to the consumer logic beyond what's needed for this specific defect
- Performance optimizations unrelated to the selection problem
