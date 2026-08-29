Improve how the Garden decides what is WORTH working on. CODE task, SDK-side.

On main now, all merged and tested:
  - `sdk/src/backlog-picker.ts` — proposes a work package from ops/BACKLOG.md;
    exports selectBacklogEntry / packageFromEntry / validateWorkPackage
  - `sdk/src/work-package-consumer.ts` — judges one, refusing with a typed
    reason (missing_title / missing_scope / missing_definition_of_done /
    nonexistent_files)
  - `testdata/backlog-picker.flow.yaml` — the flow. Its `select-entry` step
    scans for the first ACTIONABLE entry, skipping ones that fail, and exits
    nonzero with NO_ACTIONABLE_BACKLOG_ENTRY when nothing qualifies.

Do NOT re-do any of the above. Malformed-backlog handling (#30) and the
nonexistent-files check (#28) are DONE and merged. PRs #29, #31, #32 and #33
were all closed for redoing merged work or for fixing the symptom instead of
the cause. Read this brief fully before writing code.

## The defect

Run `select-entry` against the real ops/BACKLOG.md today:

    SKIPPED_UNACTIONABLE=13 Sharpen what the picker considers action[...];
      Close the deterministic-command prefligh[missing_scope];
      Release pipeline (relay pattern, NOT cra[missing_scope];
      Persist review transcripts:[missing_scope]; ...

Thirteen entries skipped. Nearly all of them are REAL engineering tasks — they
are skipped because `validateWorkPackage` judges actionability on two shallow
signals: does the text hold a backticked path, and does it hold a multi-word
backticked phrase. A task written in prose fails both. A notes blob full of
backticked identifiers passes both.

The refusal machinery is correct. What "actionable" MEANS is what is wrong.

## Hard constraints — a PR violating any of these will be closed

  - Do NOT match on entry titles, dates, or any literal string from the current
    backlog. PR #33 was closed for adding
    `/^upstream issues\s*\(\d{4}-\d{2}-\d{2}\)/` — it passed its stated goal
    while skips went 10 -> 13. Special-casing the example is not the fix.
  - Do NOT simply relax the checks until everything passes. Selecting a notes
    blob is as wrong as skipping a real task.
  - The fix must be a better DEFINITION of actionable work, applied uniformly.

## Definition of done, all of it

  - `SKIPPED_UNACTIONABLE` must fall BELOW 3 against the current
    ops/BACKLOG.md, and the entry selected must be one a human would recognise
    as engineering work. Quote the literal before/after `select-entry` output —
    the full stderr line and the selected title, both runs.
  - a test that runs `select-entry` against the REAL ops/BACKLOG.md, not a
    fixture, and asserts the skip count stays low. (PR #33 had a good version
    of this; reuse the idea.)
  - tests covering the new behaviour AND every existing test still passing
  - `cd sdk && npm test` green, and `cd kernel && sh ../ops/cargo.sh test` green
  - if you touch testdata/backlog-picker.flow.yaml you MUST regenerate
    testdata/backlog-picker.spec.canonical.json — the kernel consumes the
    canonical spec, not the yaml, and a drift test will fail you
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it
