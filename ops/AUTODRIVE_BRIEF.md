Improve how the Garden decides what is WORTH working on. CODE task, SDK-side.

On main now, all merged and tested:
  - `sdk/src/backlog-picker.ts` — proposes a work package from ops/BACKLOG.md;
    exports selectBacklogEntry / packageFromEntry / validateWorkPackage
  - `sdk/src/work-package-consumer.ts` — judges one, refusing with a typed
    reason (missing_title / missing_scope / missing_definition_of_done /
    nonexistent_files)
  - `testdata/backlog-picker.flow.yaml` — the flow. Its `select-entry` step now
    scans for the first ACTIONABLE entry, validating candidates and skipping
    the ones that fail, and exits nonzero with NO_ACTIONABLE_BACKLOG_ENTRY when
    nothing qualifies.

Do NOT re-do any of the above. Malformed-backlog handling (PR #30) and the
nonexistent-files check (PR #28) are DONE and merged. Three separate runs
already produced duplicate implementations of the latter and all three were
closed. A PR redoing either will be closed.

## The actual defect

Run `select-entry` against the real ops/BACKLOG.md. It prints:

    SKIPPED_UNACTIONABLE=10 ...

and then selects a dated notes blob ("Upstream issues (2026-08-27):") as the
work package. Ten genuine engineering tasks were skipped in favour of a list of
links.

The cause: `validateWorkPackage` decides "actionable" using only two shallow
signals — does the text contain a backticked path, and does it contain a
multi-word backticked phrase. A notes blob full of backticked identifiers
passes both. A real task written in prose ("Refuse a path-like deterministic
command word when that path does not exist") fails both.

The guard is correct. The SELECTION is poor. That is what to fix.

## Definition of done, all of it

  - a sharper notion of actionability in `sdk/src/backlog-picker.ts`, wired
    into sdk/src/index.ts if it is a new export
  - it must SELECT a real engineering task from the current ops/BACKLOG.md and
    must NOT select the "Upstream issues" notes entry. Quote the literal
    before/after `select-entry` output in your summary — the actual title it
    picked before your change and after it.
  - tests covering the new behaviour AND every existing test still passing
  - `cd sdk && npm test` green, and `cd kernel && sh ../ops/cargo.sh test` green
  - if you touch testdata/backlog-picker.flow.yaml you MUST regenerate
    testdata/backlog-picker.spec.canonical.json — the kernel consumes the
    canonical spec, not the yaml, and a drift test will fail you
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it
