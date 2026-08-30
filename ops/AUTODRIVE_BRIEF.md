Make ops/NEXT.md a checked artifact instead of free prose. CODE task, SDK-side.

## Do not re-do these

Merged and closed; a PR redoing any will be closed:
  - picker actionability (#42), unterminated backticks (#45)
  - deterministic-command preflight refusal (#47) — path-like words that do not
    exist refuse, bare words still warn, and shell prefixes like
    `TMPDIR=/tmp printf ok` must keep WARNING. Do not touch preflight.
  - the gate-1 race regression test (#48) — rewritten around the `after_ready`
    seam, confirmed to fail against a reverted PR #18 and to pass 20/20 with it.
    Do not touch kernel/relayflowd/src/server/tests.rs or server.rs.

## The problem, from evidence

Every run writes `ops/NEXT.md`. Reviewers have raised findings against it on
FOUR separate PRs (#19, #35, #40, #48), always the same two shapes:

  - it asserts a test result without carrying the command or its output
    ("all merged and tested", "three tests pass")
  - it cites a file that is not in the delivered tree (`ops/TARGET.md`)

Those are cheap findings that cost a review round trip each time, and they
recur because nothing checks the file. It is prose, so anything can be written
in it, including claims that are not true.

## The task

An SDK function that validates a NEXT.md work package and refuses it with a
typed reason, in the same style as `validateWorkPackage` in
`sdk/src/backlog-picker.ts` — read that first and match its shape.

At minimum it must catch the two observed shapes:
  - a claim of passing tests with no captured command output near it
  - a reference to a repo path that does not exist

`sdk/src/work-package-consumer.ts` already takes an injected `pathExists` for
exactly this kind of check — reuse that pattern rather than calling the
filesystem directly, and note WHY: it is what makes the check testable.

## Definition of done, all of it

  - the validator in sdk/src, exported from sdk/src/index.ts
  - typed refusal reasons, not booleans and not thrown strings
  - run it against the ops/NEXT.md files from PRs #19 and #35 — both must be
    REFUSED, and quote the reasons. If it accepts them it has not caught the
    real defect.
  - a well-formed NEXT.md must still be ACCEPTED. Include one in the tests.
  - `cd sdk && npm test` green, and `cd kernel && sh ../ops/cargo.sh test` green
  - the picker must not regress. Measure against MAIN ON THE SAME BACKLOG, not
    a number from an older brief — the count moves when the backlog moves:

        node -e 'const fs=require("node:fs");
          const sdk=require("./sdk/dist/backlog-picker.js");
          const t=fs.readFileSync("ops/BACKLOG.md","utf8");
          const e=[...t.matchAll(/^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/gm)]
            .map(m=>({title:m[1],body:m[2].replace(/\s+/g," ").trim()}));
          let ok=0; for(const x of e)
            if(sdk.validateWorkPackage(sdk.packageFromEntry(x)).accepted) ok++;
          console.log("TOTAL="+e.length+" ACTIONABLE="+ok)'

  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it
