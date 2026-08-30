# NEXT — Work package for this tick

**Gate:** 3 (CODE task, KERNEL-side, Rust)

**Target scope (quoted from ops/TARGET.md, which is NOT in the delivered diff):**

> Make the gate-1 race test actually prove something. PR #18 fixed a real race: the run lock now makes an append's journal commit and its hub notification atomic with respect to watch registration. The production change was reviewed and is sound.
>
> **Its regression test has never been observed to fail.** The assertion rests on a 100ms timeout — `kernel/relayflowd/src/server/tests.rs:306`:
>
>     let _ = watch_is_ready.recv_timeout(Duration::from_millis(100));
>
> That is a scheduling race, not a synchronisation point: it can pass without the fix and fail spuriously with it. A test that has never been seen to fail proves nothing.
>
> There IS a proper seam already: `after_ready` in `kernel/relayflowd/src/server.rs:427`, called at line 460, exists precisely to pin this ordering.

## Objective

Rewrite the race test at `kernel/relayflowd/src/server/tests.rs:306` to use EXPLICIT synchronization via the existing `after_ready` seam instead of a 100ms timeout. The test must force the interleaving with two threads and a channel, proving the fix works by **failing deterministically against the pre-fix code** and passing with it.

## Files in scope

- `kernel/relayflowd/src/server/tests.rs` — the test rewrite
- NO production changes to `kernel/relayflowd/src/server.rs` — the fix is already merged and reviewed in PR #18

## Definition of done

All of the following must be satisfied with literal command outputs pasted:

1. **Test rewritten with explicit synchronization** — two threads and a channel, using `after_ready` to control ordering. No sleeps, no timeouts standing in for ordering.

2. **CONFIRMED TO FAIL against the pre-fix server.rs** — this is the whole point:
   - Locally revert the PR #18 production change in `server.rs`
   - Run the test: `cd kernel && sh ../ops/cargo.sh test <test_name>`
   - **Quote the literal failure output** showing the test fails
   - Restore the fix
   - Run the test again showing it passes with the fix in place

3. **All kernel tests pass:**
   ```
   cd kernel && sh ../ops/cargo.sh test
   ```

4. **All SDK tests pass:**
   ```
   cd sdk && npm test
   ```

5. **Test must not be flaky** — run it at least 20 times in a row and report the count:
   ```
   for i in $(seq 20); do cd kernel && sh ../ops/cargo.sh test <test_name> || exit 1; done
   ```

6. **As the LAST action:** run `git status --porcelain` and paste the output

## Out of scope

- Any changes to production code in `server.rs` behavior — the fix is already merged
- New production code or seams — the `after_ready` seam already exists
- Work on any other gate
- Fixing SDK test failures (known issue per STATE.md)
- Any TypeScript or SDK work

## Note

This is Rust, not TypeScript, and the seam already exists — the work is the test and its proof, not new production code. If you find yourself changing server.rs's behavior to make the test pass, stop: that is a different task and the fix is already merged and reviewed.

Several drive runs execute in parallel, each pinned to a different gate. Work outside this target collides with a sibling run, so staying inside it is mandatory for safe parallel execution.
