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
were closed, and #34 merged a partial improvement for redoing merged work or for fixing the symptom instead of
the cause. Read this brief fully before writing code.

## The defect

Measure every entry in the real ops/BACKLOG.md, not just the ones scanned
before the first success:

    node -e 'const fs=require("node:fs");
      const sdk=require("./sdk/dist/backlog-picker.js");
      const t=fs.readFileSync("ops/BACKLOG.md","utf8");
      const e=[...t.matchAll(/^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/gm)]
        .map(m=>({title:m[1],body:m[2].replace(/\s+/g," ").trim()}));
      let ok=0; for(const x of e)
        if(sdk.validateWorkPackage(sdk.packageFromEntry(x)).accepted) ok++;
      console.log("TOTAL="+e.length+" ACTIONABLE="+ok)'

Today that prints `TOTAL=30 ACTIONABLE=4`. Twenty-six entries are real
engineering tasks the picker cannot select, nearly all for `missing_scope`,
because `validateWorkPackage` judges actionability on two shallow signals: does
the text hold a backticked path, and does it hold a multi-word backticked
phrase. A task written in prose fails both.

The refusal machinery is correct. What "actionable" MEANS is what is wrong.

DO NOT use `SKIPPED_UNACTIONABLE` as your measure. It counts only the entries
skipped BEFORE the first success, so it falls when a selectable entry happens to
sit near the top of the file, with nothing improved. PR #34 was merged with
`SKIPPED_UNACTIONABLE=1` and `ACTIONABLE` unchanged at 4.

## The specific mistake three attempts have made

#33, #34 and #39 all changed how `definition_of_done` is computed. Measure the
rejection reasons and you can see why none of them worked:

    rejection reasons: {"missing_scope":25,"missing_definition_of_done":3}

Twenty-five of twenty-seven rejections are SCOPE. Every attempt so far has been
adjusting the wrong field.

## Why scope is empty

`packageFromEntry` fills `files_in_scope` from backticked tokens that look like
paths — they must contain a `/`. Real entries mostly backtick SYMBOLS and
COMMANDS instead:

    "Refuse an entry with unterminated backticks."
      backticked: `validateWorkPackage` `nested_bullet` `missing_body`
      files_in_scope: []

    "Half the drive runs complete but build nothing."
      backticked: `agent-relay cloud logs <run-id>` `500 Internal Server Error`
      files_in_scope: []

A backticked symbol is perfectly good evidence of where work belongs —
`validateWorkPackage` names a function that exists in exactly one file. The
picker throws that signal away because it only pattern-matches slashes.

That is the defect. Fix scope, not the definition of done.

## Hard constraints — a PR violating any of these will be closed

  - Do NOT match on entry titles, dates, or any literal string from the current
    backlog. PR #33 was closed for adding
    `/^upstream issues\s*\(\d{4}-\d{2}-\d{2}\)/` — it passed its stated goal
    while skips went 10 -> 13. Special-casing the example is not the fix.
  - Do NOT simply relax the checks until everything passes. Selecting a notes
    blob is as wrong as skipping a real task — the count must rise BECAUSE real
    tasks became selectable, not because the bar vanished. Report what the
    picker now selects, so that can be judged.
  - Do NOT add a condition that an entry must ALSO satisfy. Every attempt that
    did made the number worse. Add an alternative way to qualify instead.
  - Do NOT touch `definition_of_done` expecting the number to move. Only 3 of
    27 rejections are about it. Report the rejection-reason breakdown before
    and after, so it is clear which field you actually changed.
  - The fix must be a better DEFINITION of actionable work, applied uniformly.

## Definition of done, all of it

  - the ACTIONABLE count above must rise from 4 to at least 20 of 30, and the
    entry selected must still be one a human would recognise as engineering
    work — do not get there by accepting everything. Quote the literal
    before/after output of that exact command.
  - a test that runs the aggregate count against the REAL ops/BACKLOG.md, not a
    fixture, and asserts it stays high. (PR #33 had a good version of the
    run-against-the-real-backlog idea; reuse it with the aggregate measure.)
  - tests covering the new behaviour AND every existing test still passing
  - `cd sdk && npm test` green, and `cd kernel && sh ../ops/cargo.sh test` green
  - if you touch testdata/backlog-picker.flow.yaml you MUST regenerate
    testdata/backlog-picker.spec.canonical.json — the kernel consumes the
    canonical spec, not the yaml, and a drift test will fail you
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it
