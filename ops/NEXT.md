# NEXT — Gate 3: Sharpen backlog-picker actionability (both scope AND definition_of_done)

**Scope from ops/TARGET.md:**

> Improve how the Garden decides what is WORTH working on. CODE task, SDK-side.
>
> On main now, all merged and tested:
>   - `sdk/src/backlog-picker.ts` — proposes a work package from ops/BACKLOG.md;
>     exports selectBacklogEntry / packageFromEntry / validateWorkPackage
>   - `sdk/src/work-package-consumer.ts` — judges one, refusing with a typed
>     reason (missing_title / missing_scope / missing_definition_of_done /
>     nonexistent_files)
>   - `testdata/backlog-picker.flow.yaml` — the flow. Its `select-entry` step
>     scans for the first ACTIONABLE entry, skipping ones that fail, and exits
>     nonzero with NO_ACTIONABLE_BACKLOG_ENTRY when nothing qualifies.

## Current state

SDK tests: **19 failed** (158 passed). Most failures are CLI/kernel integration tests for features (parked llm steps, worker dispatch) that are failing due to missing CLIs or exec bit issues in the sandbox environment. These are **known sandbox faults per ops/STATE.md** (no exec bit preserved, no gh auth).

Kernel tests: **74 passed, 0 failed**.

The backlog-picker itself works but rejects too many real tasks:

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

**Current output: TOTAL=30 ACTIONABLE=4** (per TARGET.md, though need to verify current count).

**Target: ACTIONABLE must rise from 5 to at least 20 of 32.**

Rejection breakdown after PR #41:
- `missing_scope`: 25 of 27 rejections (binding constraint)
- entries WITH scope: 8 of 32
- entries WITH definition_of_done: 14 of 32
- ACTIONABLE: 5 of 32

## The defect (quoted from TARGET.md)

> `packageFromEntry` fills `files_in_scope` from backticked tokens that look like
> paths — they must contain a `/`. Real entries mostly backtick SYMBOLS and
> COMMANDS instead:
>
>     "Refuse an entry with unterminated backticks."
>       backticked: `validateWorkPackage` `nested_bullet` `missing_body`
>       files_in_scope: []
>
>     "Half the drive runs complete but build nothing."
>       backticked: `agent-relay cloud logs <run-id>` `500 Internal Server Error`
>       files_in_scope: []
>
> A backticked symbol is perfectly good evidence of where work belongs —
> `validateWorkPackage` names a function that exists in exactly one file. The
> picker throws that signal away because it only pattern-matches slashes.
>
> That is the defect. Fix scope, not the definition of done.

BUT (critical update from TARGET.md):
> Run 5ecf7078 proved that by refusing the task with a reproduction: with scope
> forced valid for every entry the ceiling is 14 of 32, because 18 entries
> produce no definition_of_done at all. A scope-only fix cannot pass 20 — the
> target was unreachable and the refusal was correct.

**BOTH fields need work.** Scope is the larger blocker (25 of 27 rejections), but definition_of_done blocks 18 entries even if scope passes.

## Objective

Extend `scopeReferences()` in `sdk/src/backlog-picker.ts` (PR #41 introduced this function — EXTEND it, do not restart from scratch) to accept backticked symbols and commands as scope evidence, not only slash-containing paths. AND add an additional route for `definition_of_done` to qualify beyond just backticked commands with flags.

## Files in scope

- `sdk/src/backlog-picker.ts` — extend `scopeReferences()` and improve definition_of_done extraction
- `sdk/tests/backlog-picker.test.ts` — tests for the new behavior
- `sdk/tests/work-package-consumer.test.ts` — if consumer changes needed
- `testdata/backlog-picker.flow.yaml` — ONLY if the flow logic changes
- `testdata/backlog-picker.spec.canonical.json` — regenerate ONLY if yaml changes

## Definition of done

ALL of the following must hold:

1. **Before/after measurement** — run this exact command and quote the literal output BEFORE and AFTER:
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
   ACTIONABLE must rise from 5 to at least 20.

2. **Rejection-reason breakdown** — measure and report the rejection reasons before and after:
   ```
   node -e 'const fs=require("node:fs");
     const sdk=require("./sdk/dist/backlog-picker.js");
     const t=fs.readFileSync("ops/BACKLOG.md","utf8");
     const e=[...t.matchAll(/^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/gm)]
       .map(m=>({title:m[1],body:m[2].replace(/\s+/g," ").trim()}));
     const reasons={}; for(const x of e) {
       const r=sdk.validateWorkPackage(sdk.packageFromEntry(x));
       if(!r.accepted) reasons[r.reason]=(reasons[r.reason]||0)+1;
     }
     console.log("rejection reasons:",JSON.stringify(reasons))'
   ```

3. **Test that runs against the real ops/BACKLOG.md** and asserts the count stays high (reuse the pattern from PR #33 with the aggregate measure, not SKIPPED_UNACTIONABLE)

4. **Every new test CONFIRMED TO FAIL** against current code before the fix. Quote the literal failing output.

5. **All existing tests still passing:**
   ```
   cd sdk && npm test
   cd kernel && sh ../ops/cargo.sh test
   ```
   Both must exit 0. Known sandbox failures in CLI tests (missing authenticated-cli executable) are acceptable per ops/STATE.md but quote what passed.

6. **If testdata/backlog-picker.flow.yaml is modified:** regenerate `testdata/backlog-picker.spec.canonical.json` with the SDK's compiler

7. **Final verification** as the LAST action:
   ```
   git status --porcelain
   ```
   Paste the output.

## Hard constraints (quoted from TARGET.md)

- Do NOT match on entry titles, dates, or any literal string from the current backlog
- Do NOT simply relax the checks until everything passes — report what the picker now selects so it can be judged
- Do NOT add a condition that an entry must ALSO satisfy — add an alternative way to qualify instead
- The fix must be a better DEFINITION of actionable work, applied uniformly

## Out of scope

- Any work on gates 1, 2, 4, 5, 6, 7, 8, 9
- Re-implementing malformed-backlog handling (PR #30, merged)
- Re-implementing nonexistent-files check (PR #28, merged)
- Fixing the SDK CLI test failures (those are sandbox environment issues per STATE.md)
