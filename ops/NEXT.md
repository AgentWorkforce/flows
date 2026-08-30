# Work package for this tick — gate 3

**Target scope from TARGET.md:**
Make the gate-1 race test actually prove something. CODE task, KERNEL-side (Rust).

Gate 1 is GREEN with one asterisk: PR #18 fixed a real race (run lock makes append's journal commit and hub notification atomic with respect to watch registration), but **its regression test has never been observed to fail**. The assertion rests on a 100ms timeout at `kernel/relayflowd/src/server/tests.rs:306`:

```rust
let _ = watch_is_ready.recv_timeout(Duration::from_millis(100));
```

This is a scheduling race, not a synchronization point: it can pass without the fix and fail spuriously with it. A test that has never been seen to fail proves nothing.

There IS a proper seam already: `after_ready` in `kernel/relayflowd/src/server.rs:427`, called at line 460, exists precisely to pin this ordering.

## Objective

Rewrite the race test to use EXPLICIT synchronization (two threads and a channel) so the interleaving is forced rather than hoped for. Confirm it fails against the pre-fix server.rs, then passes with the fix. Ensure the test is not flaky.

## Files in scope

- `kernel/relayflowd/src/server/tests.rs` — the test to rewrite (around line 306)
- `kernel/relayflowd/src/server.rs` — READ ONLY to understand the `after_ready` seam (line 427, 460)

## Definition of done — ALL of these

1. **Test rewritten around `after_ready` with EXPLICIT synchronization** — two threads and a channel, so the interleaving is forced rather than hoped for. No sleeps, no timeouts standing in for ordering.

2. **CONFIRMED TO FAIL against the pre-fix server.rs** — this is the whole point. Revert the PR #18 production change locally, run the test, and quote the literal failure output; then restore the fix and show it passing.

3. **Kernel tests green:**
   ```bash
   cd kernel && sh ../ops/cargo.sh test
   ```
   Full output required.

4. **SDK tests green:**
   ```bash
   cd sdk && npm test
   ```
   Full output required.

5. **Test must not be flaky** — run it at least 20 times in a row and report the count:
   ```bash
   for i in $(seq 20); do cd kernel && sh ../ops/cargo.sh test <test-name>; done
   ```
   Full output required.

6. **As the LAST action, run `git status --porcelain` and paste it.**

## Explicitly OUT of scope

- **Do NOT change server.rs behavior** — the fix is already merged and reviewed. This is Rust, not TypeScript, and the seam already exists. The work is the test and its proof, not new production code.
- **Do NOT touch preflight** — regression closed in PR #47, see TARGET.md "Do not re-do these".
- **Do NOT work on other gates** — several drive runs execute in parallel, each pinned to a different gate. Work outside this target collides with a sibling run.

## Current state

- SDK tests failing (22 failed, 167 passed) — appears to be environmental (live kernel tests timing out), not related to this work package.
- Kernel tests currently passing (6 passed per quick check).
- No open PRs blocking this work per STATE.md (only #19 is open, for gate 2).

## Next action

Read the full test around line 270-341 in kernel/relayflowd/src/server/tests.rs to understand the current implementation, then rewrite it to use explicit synchronization via the `after_ready` callback.
