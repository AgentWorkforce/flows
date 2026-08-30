# Work package — gate 3: close deterministic-command preflight gap

**Target (from ops/TARGET.md):** Close the deterministic-command preflight gap (Codex P1). CODE task, SDK-side.

## Objective

Strengthen preflight validation so that a deterministic step whose first command word contains `/` and does not exist is REFUSED (not warned). Bare words that don't resolve continue to WARN exactly as today.

## Files in scope

- `sdk/src/preflight.ts` — modify `warnOnUnprovableEffects` (lines 237-278) to distinguish path-like commands from bare words
- `sdk/src/failure-kinds.ts` — add new refusal kind if needed
- `sdk/tests/*.test.ts` — add tests proving both behaviors

## Definition of done

ALL of the following must hold:

1. **Path-like refusal implemented:** A deterministic step whose first command word contains `/` and does not exist triggers a REFUSAL (not a warning). The refusal must flow through the real `preflight()` entry point.

2. **Bare-word warning preserved:** Bare unresolved words (no `/`) still emit a WARNING. A test must prove this path is unchanged from current behavior.

3. **Kernel tests green:**
   ```
   cd kernel && sh ../ops/cargo.sh test
   ```
   Must show `test result: ok. 71 passed; 0 failed`.

4. **SDK tests green:**
   ```
   cd sdk && npm test
   ```
   Must show all tests passing (currently 22 fail, mostly on missing executable flag for `authenticated-cli`).

5. **Picker must not regress:** Measure against MAIN on the SAME backlog:
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
   Record the baseline BEFORE changes, verify it does not drop AFTER.

6. **New tests fail against current code:** Every new test added for this work must be demonstrated to FAIL against the current code. Paste the literal failing output.

7. **Final git status pasted:** As the LAST action, run `git status --porcelain` and paste the output.

## Explicitly OUT of scope

- Preflight for llm/agent steps (CLI resolution) — not touched
- Trigger validation — not touched
- Any work outside sdk/src/preflight.ts and its tests
- Performance optimization
- Changing existing warning kinds or messages beyond what is required for the path/bare distinction
- Work on any gate other than gate 3

## Notes

The current `warnOnUnprovableEffects` function (sdk/src/preflight.ts:237) treats all unresolved commands the same. The fix requires:
- Detecting `/` in the command word via `firstCommandWord()`
- When `/` is present AND `probes.command(binary)` returns false, push a REFUSAL diagnostic instead of a WARNING
- When `/` is absent AND command doesn't resolve, keep the current WARNING behavior

Example failing case (should refuse, currently warns):
```yaml
steps:
  - id: build
    type: deterministic
    command: ./ops/nonexistent.sh
```

Example that should keep warning (bare word):
```yaml
steps:
  - id: build
    type: deterministic
    command: nonexistent
```
