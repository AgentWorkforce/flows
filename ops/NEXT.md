# NEXT — Gate 3: Validate ops/NEXT.md structure

**Target:** Gate 3 only. This run is pinned to gate 3 and must not work on any other gate.

**Scope from TARGET.md (quoted, not cited):** Make ops/NEXT.md a checked artifact instead of free prose. CODE task, SDK-side.

Every run writes ops/NEXT.md. Reviewers have raised findings against it on FOUR separate PRs (#19, #35, #40, #48), always the same two shapes:
- it asserts a test result without carrying the command or its output ("all merged and tested", "three tests pass")
- it cites a file that is not in the delivered tree (ops/TARGET.md)

Those are cheap findings that cost a review round trip each time, and they recur because nothing checks the file.

## Objective

Create an SDK function that validates a NEXT.md work package and refuses it with typed reasons, matching the pattern in sdk/src/backlog-picker.ts validateWorkPackage and sdk/src/work-package-consumer.ts consumeWorkPackage.

At minimum it must catch the two observed shapes:
- a claim of passing tests with no captured command output near it
- a reference to a repo path that does not exist

## Files in scope

- sdk/src/next-validator.ts (new file for the validator function)
- sdk/src/index.ts (export the validator)
- sdk/tests/next-validator.test.ts (new test file)
- testdata/next-examples/ (directory for test NEXT.md examples)

## Definition of done

All of the following MUST pass with literal command output quoted:

1. The validator in sdk/src/next-validator.ts exists and is exported from sdk/src/index.ts

2. Typed refusal reasons (not booleans, not thrown strings) following the pattern:
   - 'uncaptured_test_claim' - claims passing tests without command output
   - 'nonexistent_path_reference' - references a path that doesn't exist

3. Tests against bad NEXT.md examples representing PRs #19 and #35 patterns - both MUST be REFUSED:
   ```
   cd sdk && npm test 2>&1 | grep -A 5 "next-validator"
   ```
   Output must show tests passing that verify refusal of:
   - test claims without output (the #19/#35 pattern)
   - nonexistent path references (ops/TARGET.md pattern)

4. A well-formed NEXT.md MUST be ACCEPTED - test must demonstrate this

5. SDK tests green:
   ```
   cd sdk && npm test
   ```
   Must show: Test Files X passed, Tests Y passed (all green, 0 failed)

6. Kernel tests green (no regression):
   ```
   cd kernel && sh ../ops/cargo.sh test
   ```
   Must show: test result: ok. N passed; 0 failed

7. Picker actionability must not regress from main. Measure against MAIN ON THE SAME BACKLOG:
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
   Count must match or exceed the baseline from main

8. EVERY new test confirmed to FAIL against current code before implementation:
   - Run tests before implementing validator
   - Quote the literal failing output for each test
   - Then implement and show tests passing

9. Final git status to verify all changes are tracked:
   ```
   git status --porcelain
   ```

## Out of scope

- Integration with any build or CI pipeline
- Validation of other markdown files
- Parsing NEXT.md into structured data (only validation of common error patterns)
- Automatic fixing of invalid NEXT.md files
- Work on any other gate (this is gate 3 only)
- Changes to kernel/ code
- Changes to backlog-picker.ts or work-package-consumer.ts beyond reading for pattern reference
