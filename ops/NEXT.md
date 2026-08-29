# NEXT — Gate 3: Build the work package consumer

**Scope:** Gate 3 — close the Garden's loop. CODE task, SDK-side. The picker EMITS a work package (sdk/src/backlog-picker.ts + testdata/backlog-picker.flow.yaml, merged, four tested properties) and NOTHING consumes it — that is the missing half. Build the consumer: an SDK entrypoint taking an emitted package and turning it into something runnable, validating it has a title, a non-empty scope and a definition of done, and REFUSING with a typed reason when it does not, because a package that cannot be verified must not become work. NOTE: two previous attempts (ee5c9b3e, 06c0d6ab) did this correctly and their files were LOST before delivery by a platform fault — the build sandbox's .git points at a directory that does not exist, so writes cannot be captured. You are not duplicating live work.

## Objective

Build the SDK entrypoint that takes an emitted work package and turns it into something runnable. The consumer must validate that the package has:
- A title (non-empty string)
- A non-empty scope
- A definition of done

When any of these is missing or invalid, the consumer REFUSES with a typed reason. A package that cannot be verified must not become work.

## Files in scope

- `sdk/src/` (new consumer code)
- `sdk/tests/` (new consumer tests)
- NO changes to `kernel/` (PR #19 is open)
- NO changes to `sdk/src/demo-hn-monitor.ts` (PR #19 is open)

## Definition of done

1. **SDK code exists** that consumes an emitted work package
2. **Validation tests exist** for:
   - Missing title → typed refusal
   - Empty title → typed refusal
   - Missing scope → typed refusal
   - Empty scope → typed refusal
   - Missing definition of done → typed refusal
   - Empty definition of done → typed refusal
   - Valid package → accepted
3. **Every new test is confirmed to FAIL against current code** with literal output pasted
4. **SDK test suite passes:**
   ```
   cd sdk && npm test
   ```
   Paste the literal output showing all tests pass, 0 failed
5. **Final verification** — as the LAST action, run:
   ```
   git status --porcelain
   ```
   And paste the output to make lost writes visible immediately

## Out of scope

- Kernel changes (different PR)
- Integration with hn-monitor (different PR)
- Any changes to the backlog picker itself (already merged in PRs #20, #21, #22)
- Changes to flow execution or scheduling
