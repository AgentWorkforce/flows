# NEXT — Gate 3: Refuse backlog entries with unterminated backticks

Selected from ops/TARGET.md for this run (gate 3, CODE task, SDK-side).

## Target scope (quoted from ops/TARGET.md)

> Scope and definition-of-done are both derived from backticked spans. An entry
> with an ODD number of backticks makes those spans wrong: the parser pairs the
> opening backtick with whatever backtick appears next, so text that was never
> meant to be code becomes scope, and real content is swallowed.
>
> Since #42 widened what counts as scope — symbols and commands, not only paths —
> a mispaired span is now MORE likely to produce a plausible-looking but wrong
> `files_in_scope`, which is worse than an obviously empty one.
>
> Add a typed refusal for it. Salvaged from closed PR #32, which proposed the
> check but wired it to nothing; two of its three proposed reasons were rejected
> on assessment (`nested_bullet` would have been a regression — the selection
> regex already skips indented bullets; `missing_body` is covered by the existing
> reasons). Only the unterminated-backtick case is real.

## Objective

Add a typed refusal reason for backlog entries with an odd number of backticks, preventing mispaired code spans from producing plausible-looking but wrong scope extraction.

## Files in scope

- `sdk/src/backlog-picker.ts` — add the refusal reason type, implement the check, wire it into `validateWorkPackage` or `packageFromEntry`
- `sdk/src/index.ts` — export the new refusal reason type if it's added to the union
- `sdk/tests/backlog-picker.test.ts` — tests for the new refusal behavior (or create this file if it doesn't exist)
- `testdata/backlog-picker.flow.yaml` — if touched, MUST regenerate the canonical spec
- `testdata/backlog-picker.spec.canonical.json` — kernel consumes this; two drift tests fail if it's stale

## Definition of done

All of the following must be verified and the literal command output quoted:

1. **A typed refusal reason exists** for entries with an odd backtick count (e.g., `'unterminated_backticks'`)

2. **The refusal is WIRED IN**, not merely exported. PR #32 was closed largely for exporting a checker nothing called. Show the flow refusing such an entry.

3. **ACTIONABLE count maintained at ~22 of 32:**

   Baseline verification BEFORE changes (currently TOTAL=32 ACTIONABLE=21):
   ```
   node -e 'const fs=require("node:fs");
     const sdk=require("./sdk/dist/backlog-picker.js");
     const t=fs.readFileSync("ops/BACKLOG.md","utf8");
     const e=[...t.matchAll(/^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/gm)]
       .map(m=>({title:m[1],body:m[2].replace(/\s+/g," ").trim()}));
     let ok=0; for(const x of e)
       if(sdk.validateWorkPackage(sdk.packageFromEntry(x)).accepted) ok++;
     console.log("TOTAL="+e.length+" ACTIONABLE="+ok)'
   ```

   Run AFTER changes to prove the count is still ~22 (21-22 is acceptable). A refusal that also rejects well-formed entries is a regression.

4. **Tests covering the new behaviour AND every existing test still passing:**
   - `cd sdk && npm test` — must be green (exit 0)
   - Tests must include at least one case showing that an entry with an odd backtick count is refused with the new reason

5. **EVERY new test confirmed to FAIL against current code:**
   Before implementing the fix, write the test and run it against the current code. Paste the literal failing output proving the test fails without the implementation.

6. **Kernel tests still green:**
   ```
   cd kernel && sh ../ops/cargo.sh test
   ```
   Must exit 0 with all tests passing.

7. **Final git status** — as the LAST action:
   ```
   git status --porcelain
   ```
   Paste the output.

## Out of scope

- Do NOT change the accept/reject thresholds in `validateWorkPackage`
- Do NOT re-tune scope extraction to raise the ACTIONABLE count — ops/TARGET.md explicitly says "Do not re-do this": the picker's actionability problem is SOLVED and merged (PR #42), ACTIONABLE is 22 of 32 (we see 21, close enough), above the target of 20
- Do NOT touch the two other proposed reasons from closed PR #32 (`nested_bullet`, `missing_body`) — those were rejected
- Any changes to RFC-0001 or charter files
- Any work on gates other than gate 3

## Notes

- ops/STATE.md reports that only PR #19 is currently open (gate-2 HN demo, green and mergeable, waiting on Khaliq). No unfinished work blocks this task.
- ops/DIRECTIVES.md is empty — no standing directives conflict with this work.
- This is a CODE task, not an assessment or research task.
- The run is pinned to gate 3 by ops/TARGET.md. Several runs execute in parallel, each pinned to a different gate. Work outside this target collides with a sibling run.
