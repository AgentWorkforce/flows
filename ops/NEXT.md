# NEXT — Gate 3: Close the deterministic-command preflight gap

**Gate:** 3 (deterministic-command preflight gap, Codex P1)

**Scope from ops/TARGET.md:**

`warnOnUnprovableEffects` in `sdk/src/preflight.ts` emits a WARNING for every deterministic step whose command word does not resolve. Its own comment gives the reason:

    These warn rather than refuse because a string command is executed as
    `/bin/sh -c`, so an unresolved first word may still be a shell builtin,
    function, or assignment — refusing would reject valid flows.

That reasoning is correct for a BARE word like `mkdir` or `myfunc`. It does not hold for a word containing `/`. `./scripts/build.sh` or `ops/cargo.sh` is unambiguously a path: it cannot be a builtin, a function, or an assignment. If that path does not exist, the step cannot possibly run, and preflight knows it before execution.

So: a path-like command word that does not exist must REFUSE. A bare word that does not resolve must keep WARNING, exactly as today.

Filed from PR #8 and deliberately deferred then. This is that deferred work.

## Objective

Make preflight REFUSE (not WARN) when a deterministic step's first command word contains `/` and does not exist, while keeping bare unresolved words as warnings.

## Files in scope

- `sdk/src/preflight.ts` — modify `warnOnUnprovableEffects()` to refuse path-like commands (containing `/`) that don't exist
- `sdk/src/failure-kinds.ts` — may need to add a new refusal kind like `command_path_missing`
- `sdk/tests/preflight.test.ts` OR new test file — add tests proving both behaviors

## Definition of done (all required)

1. **A REFUSAL (not a warning) for a deterministic step whose first command word contains `/` and does not exist**

2. **Bare unresolved words still WARN** — a test proving the warning path is unchanged, so the fix cannot pay for itself by refusing more broadly

3. **Both behaviors reachable through the real `preflight()` entry point**, not only through an internal helper

4. **`cd sdk && npm test` green, and `cd kernel && sh ../ops/cargo.sh test` green**

5. **The picker must not regress.** Measure it against MAIN ON THE SAME BACKLOG, not against a number quoted in an older brief — the count moves when the backlog moves, and a stale figure produces false regressions:
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

6. **EVERY new test confirmed to FAIL against current code, with the literal failing output quoted in your summary**

7. **As your LAST action, run `git status --porcelain` and paste it**

## Explicitly OUT of scope

- Changes to the kernel (this is SDK-side only per TARGET.md)
- Any other preflight refusals or warnings beyond the path-like command gap
- CLI probe behavior
- Integration with other gates
- Work on any other gate

## Already done (DO NOT re-do)

Per ops/TARGET.md, both are merged and closed. A PR redoing either will be closed:
- picker actionability (PR #42) — ACTIONABLE is ~21 of 32, above target
- unterminated-backtick refusal (PR #45)
