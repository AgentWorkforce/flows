Refuse a backlog entry whose backticks are unterminated. CODE task, SDK-side.

## Do not re-do this

The picker's actionability problem is SOLVED and merged (PR #42): ACTIONABLE is
22 of 32 against the real ops/BACKLOG.md, above the target of 20. Do not touch
`validateWorkPackage`'s accept/reject thresholds or re-tune scope extraction to
raise that number. Five PRs (#33, #34, #39, #41, #42) worked that problem; four
were closed. It is done.

Verify before you start, so you are working from fact rather than this brief:

    node -e 'const fs=require("node:fs");
      const sdk=require("./sdk/dist/backlog-picker.js");
      const t=fs.readFileSync("ops/BACKLOG.md","utf8");
      const e=[...t.matchAll(/^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/gm)]
        .map(m=>({title:m[1],body:m[2].replace(/\s+/g," ").trim()}));
      let ok=0; for(const x of e)
        if(sdk.validateWorkPackage(sdk.packageFromEntry(x)).accepted) ok++;
      console.log("TOTAL="+e.length+" ACTIONABLE="+ok)'

That should print roughly TOTAL=32 ACTIONABLE=22. It must still print that when
you are finished.

## The task

Scope and definition-of-done are both derived from backticked spans. An entry
with an ODD number of backticks makes those spans wrong: the parser pairs the
opening backtick with whatever backtick appears next, so text that was never
meant to be code becomes scope, and real content is swallowed.

Since #42 widened what counts as scope — symbols and commands, not only paths —
a mispaired span is now MORE likely to produce a plausible-looking but wrong
`files_in_scope`, which is worse than an obviously empty one.

Add a typed refusal for it. Salvaged from closed PR #32, which proposed the
check but wired it to nothing; two of its three proposed reasons were rejected
on assessment (`nested_bullet` would have been a regression — the selection
regex already skips indented bullets; `missing_body` is covered by the existing
reasons). Only the unterminated-backtick case is real.

## Definition of done, all of it

  - a typed refusal reason for an entry with an odd backtick count, exported
    from sdk/src/index.ts if it is a new type
  - it must be WIRED IN, not merely exported. PR #32 was closed largely for
    exporting a checker nothing called. Show the flow refusing such an entry.
  - the ACTIONABLE count above must still be ~22 of 32. A refusal that also
    rejects well-formed entries is a regression; report the count before and
    after.
  - tests covering the new behaviour AND every existing test still passing
  - `cd sdk && npm test` green, and `cd kernel && sh ../ops/cargo.sh test` green
  - if you touch testdata/backlog-picker.flow.yaml you MUST regenerate
    testdata/backlog-picker.spec.canonical.json — the kernel consumes the
    canonical spec, and two drift tests will fail you
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it
