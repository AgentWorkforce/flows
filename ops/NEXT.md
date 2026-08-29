# NEXT — Gate 3: Refuse backlog entry with unterminated backticks

**Scope:** Refuse a backlog entry whose backticks are unterminated. CODE task, SDK-side (gate 3).

TARGET.md (ops/TARGET.md in the launch worktree, not propagated to the package) pins this run to gate 3. The picker's actionability problem is SOLVED and merged (PR #42): ACTIONABLE is 22 of 32 against the real ops/BACKLOG.md, above the target of 20. Do not touch `validateWorkPackage`'s accept/reject thresholds or re-tune scope extraction to raise that number. Five PRs (#33, #34, #39, #41, #42) worked that problem; four were closed. It is done.

## The task

Scope and definition-of-done are both derived from backticked spans. An entry with an ODD number of backticks makes those spans wrong: the parser pairs the opening backtick with whatever backtick appears next, so text that was never meant to be code becomes scope, and real content is swallowed.

Since #42 widened what counts as scope — symbols and commands, not only paths — a mispaired span is now MORE likely to produce a plausible-looking but wrong `files_in_scope`, which is worse than an obviously empty one.

Add a typed refusal for it. Salvaged from closed PR #32, which proposed the check but wired it to nothing; two of its three proposed reasons were rejected on assessment (`nested_bullet` would have been a regression — the selection regex already skips indented bullets; `missing_body` is covered by the existing reasons). Only the unterminated-backtick case is real.

## Objective

Add a typed refusal reason for backlog entries with an odd backtick count, wire it into the validation flow, and verify it does not regress the ACTIONABLE count.

## Files in scope

- `sdk/src/backlog-picker.ts` — add `unterminated_backticks` to `WorkPackageValidationReason`, add checker function, wire it into `validateWorkPackage`
- `sdk/src/index.ts` — export the new reason if needed (already exports `WorkPackageValidationReason`)
- `sdk/tests/backlog-picker.test.ts` — tests for the new refusal, confirming it rejects entries with odd backtick counts
- `testdata/backlog-picker.flow.yaml` — if modified, must regenerate canonical spec
- `testdata/backlog-picker.spec.canonical.json` — regenerate if flow.yaml changes (kernel consumes this, drift tests will fail otherwise)

## Definition of done

All of the following must hold:

1. **Typed refusal reason exists and is wired in**
   - A new `WorkPackageValidationReason` value `'unterminated_backticks'` is added to `sdk/src/backlog-picker.ts`
   - It is checked in `validateWorkPackage` BEFORE the function accepts the package
   - PR #32 was closed for exporting a checker nothing called. Show the flow refusing such an entry.

2. **ACTIONABLE count preserved** — the ACTIONABLE count must still be ~21-22 of 32 before and after. A refusal that also rejects well-formed entries is a regression. Run this command and report the count before and after:
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

3. **New tests pass and fail correctly**
   - Add tests to `sdk/tests/backlog-picker.test.ts` covering the new refusal reason:
     - An entry with 1 backtick (odd) is refused with `unterminated_backticks`
     - An entry with 3 backticks (odd) is refused with `unterminated_backticks`
     - An entry with 2 backticks (even, well-formed) is accepted
     - An entry with 0 backticks is accepted
   - EVERY new test confirmed to FAIL against current code before implementing the fix
   - Quote the literal failing output

4. **All existing tests still pass**
   ```
   cd sdk && npm test
   ```
   All backlog-picker tests pass, all other SDK tests pass (ignore live-kernel failures — known sandbox fault per STATE.md)

5. **Kernel tests still pass**
   ```
   cd kernel && sh ../ops/cargo.sh test
   ```
   All tests green

6. **Canonical spec regenerated if flow changed**
   - If `testdata/backlog-picker.flow.yaml` was modified, regenerate `testdata/backlog-picker.spec.canonical.json` — the kernel consumes the canonical spec, and two drift tests will fail if this is skipped

7. **Final state clean** — as your LAST action, run:
   ```
   git status --porcelain
   ```
   And paste it

## Out of scope

- Tuning the accept/reject thresholds in `validateWorkPackage` — picker actionability is SOLVED per TARGET.md and STATE.md
- Modifying scope extraction logic to raise ACTIONABLE count — already done in PR #42, merged
- Working on any other gate — this run is pinned to gate 3, several runs execute in parallel, work outside this target collides with a sibling
- Any refusal reasons other than `unterminated_backticks` — PR #32's `nested_bullet` and `missing_body` were rejected as regressions or already covered
