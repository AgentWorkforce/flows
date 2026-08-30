# Work package — gate 3: validate ops/NEXT.md as a checked artifact

**Scope from this run's target:** Make ops/NEXT.md a checked artifact instead of free prose. CODE task, SDK-side.

## The problem, from evidence

Every run writes `ops/NEXT.md`. Reviewers have raised findings against it on FOUR separate PRs (#19, #35, #40, #48), always the same two shapes:

  - it asserts a test result without carrying the command or its output ("all merged and tested", "three tests pass")
  - it cites a file that is not in the delivered tree (`ops/TARGET.md`)

Those are cheap findings that cost a review round trip each time, and they recur because nothing checks the file. It is prose, so anything can be written in it, including claims that are not true.

## Objective

An SDK function that validates a NEXT.md work package and refuses it with a typed reason, in the same style as `validateWorkPackage` in `sdk/src/backlog-picker.ts` — read that first and match its shape.

At minimum it must catch the two observed shapes:
  - a claim of passing tests with no captured command output near it
  - a reference to a repo path that does not exist

`sdk/src/work-package-consumer.ts` already takes an injected `pathExists` for exactly this kind of check — reuse that pattern rather than calling the filesystem directly, and note WHY: it is what makes the check testable.

## Files in scope

- `sdk/src/work-package-validator.ts` — new file, the validator function
- `sdk/src/index.ts` — export the validator
- `sdk/tests/work-package-validator.test.ts` — new file, comprehensive tests
- `sdk/src/failure-kinds.ts` — add typed refusal reasons if needed

## Definition of done

ALL of the following must hold:

1. **The validator exists in sdk/src, exported from sdk/src/index.ts**

2. **Typed refusal reasons, not booleans and not thrown strings**

3. **Run it against the ops/NEXT.md files from PRs #19 and #35 — both must be REFUSED, and quote the reasons.** If it accepts them it has not caught the real defect.

4. **A well-formed NEXT.md must still be ACCEPTED.** Include one in the tests.

5. **`cd sdk && npm test` green:**
   ```
   cd sdk && npm test
   ```
   All tests must pass. Paste the literal command and output showing pass/fail counts.

6. **`cd kernel && sh ../ops/cargo.sh test` green:**
   ```
   cd kernel && sh ../ops/cargo.sh test
   ```
   All tests must pass. Paste the literal command and output tail.

7. **The picker must not regress.** Measure against MAIN ON THE SAME BACKLOG:
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
   Baseline on current code: `TOTAL=31 ACTIONABLE=19`
   After changes: must still show `ACTIONABLE=19` or higher.

8. **EVERY new test confirmed to FAIL against current code, with the literal failing output quoted in your summary**

9. **As your LAST action, run `git status --porcelain` and paste it**

## Explicitly OUT of scope

- Work on any gate other than gate 3
- Changing the format of ops/NEXT.md beyond validation
- Refactoring existing validators beyond what's needed for consistency
- Performance optimization
- Validating BACKLOG.md entries
- Any work in kernel/ beyond running the test suite
