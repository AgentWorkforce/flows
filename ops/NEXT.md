# NEXT — Fix scope extraction to recognize backticked symbols

**Gate 3 target from ops/TARGET.md:**

> **Scope:** Improve how the Garden decides what is WORTH working on. CODE task, SDK-side.
>
> Do NOT re-do any of the above. Malformed-backlog handling (#30) and the
> nonexistent-files check (#28) are DONE and merged. PRs #29, #31, #32 and #33
> were closed, and #34 merged a partial improvement for redoing merged work or for fixing the symptom instead of
> the cause. Read this brief fully before writing code.

## The defect (quoted from TARGET.md)

Measure every entry in the real ops/BACKLOG.md, not just the ones scanned before the first success:

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

Today that prints `TOTAL=32 ACTIONABLE=4`. Twenty-eight entries are real engineering tasks the picker cannot select, nearly all for `missing_scope`.

Current rejection breakdown:
```
rejection reasons: {"missing_scope":25,"missing_definition_of_done":3}
```

**Twenty-five of twenty-eight rejections are SCOPE.** Every attempt so far (#33, #34, #39) changed `definition_of_done`, which is the wrong field.

## Why scope is empty (quoted from TARGET.md)

`packageFromEntry` fills `files_in_scope` from backticked tokens that look like paths — they must contain a `/`. Real entries mostly backtick SYMBOLS and COMMANDS instead:

- "Refuse an entry with unterminated backticks."
  backticked: `validateWorkPackage` `nested_bullet` `missing_body`
  files_in_scope: []

- "Half the drive runs complete but build nothing."
  backticked: `agent-relay cloud logs <run-id>` `500 Internal Server Error`
  files_in_scope: []

A backticked symbol is perfectly good evidence of where work belongs — `validateWorkPackage` names a function that exists in exactly one file. The picker throws that signal away because it only pattern-matches slashes.

**That is the defect. Fix scope, not the definition of done.**

## Objective

Change `packageFromEntry` in `sdk/src/backlog-picker.ts` to accept backticked symbols as scope evidence, not just backticked paths containing `/`.

## Files in scope

- `sdk/src/backlog-picker.ts` — the `packageFromEntry` function at line 109
- `sdk/tests/backlog-picker.test.ts` — new tests required
- `ops/BACKLOG.md` — the real backlog (read-only, for measurement)

## Definition of done (all required, quoted from TARGET.md)

1. **The ACTIONABLE count must rise from 4 to at least 20 of 32**, measured by the exact command above. Quote the literal before/after output.

2. **A test that runs the aggregate count against the REAL ops/BACKLOG.md** (not a fixture) and asserts it stays high (at least 20 actionable). PR #33 had a good version of this idea; reuse it with the aggregate measure.

3. **Tests covering the new behaviour AND every existing test still passing**.

4. **`cd sdk && npm test` green**.

5. **If you touch testdata/backlog-picker.flow.yaml** you MUST regenerate testdata/backlog-picker.spec.canonical.json — the kernel consumes the canonical spec, not the yaml, and a drift test will fail you.

6. **EVERY new test confirmed to FAIL against current code**, with the literal failing output quoted.

7. **As your LAST action, run `git status --porcelain` and paste it**.

8. **Report the rejection-reason breakdown before and after**, so it is clear which field you actually changed.

9. **Report what the picker now selects**, so that can be judged — the count must rise BECAUSE real tasks became selectable, not because the bar vanished.

## Hard constraints (from TARGET.md — a PR violating any of these will be closed)

- Do NOT match on entry titles, dates, or any literal string from the current backlog
- Do NOT simply relax the checks until everything passes — selecting a notes blob is as wrong as skipping a real task
- Do NOT add a condition that an entry must ALSO satisfy — add an alternative way to qualify instead
- Do NOT touch `definition_of_done` expecting the number to move — only 3 of 28 rejections are about it
- The fix must be a better DEFINITION of actionable work, applied uniformly

## Out of scope for this tick

- Kernel changes — this is SDK-side only, gate 3
- Changes to `validateWorkPackage` — it is correct, the input it receives is wrong
- Changes to the flow yaml unless absolutely necessary
- Work on any other gate
- The nonexistent-files check — already merged in #28
- Malformed-backlog handling — already merged in #30
