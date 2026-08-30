Make the gate-1 race test actually prove something. CODE task, KERNEL-side (Rust).

## Do not re-do these

Merged and closed; a PR redoing any of them will be closed:
  - picker actionability (#42) and the unterminated-backtick refusal (#45)
  - the deterministic-command preflight refusal (#47) — path-like command words
    that do not exist now refuse; bare words still warn; shell prefixes such as
    `TMPDIR=/tmp printf ok` and `>/tmp/out echo hi` must keep WARNING, and there
    is a regression test pinning that. Do not touch preflight.

## The task

Gate 1 is GREEN with one asterisk, and this is it.

PR #18 fixed a real race: the run lock now makes an append's journal commit and
its hub notification atomic with respect to watch registration. The production
change was reviewed and is sound.

**Its regression test has never been observed to fail.** The assertion rests on
a 100ms timeout — `kernel/relayflowd/src/server/tests.rs:306`:

    let _ = watch_is_ready.recv_timeout(Duration::from_millis(100));

That is a scheduling race, not a synchronisation point: it can pass without the
fix and fail spuriously with it. A test that has never been seen to fail proves
nothing, and this is the only change in the repo that does not meet the standard
everything else does.

There IS a proper seam already: `after_ready` in
`kernel/relayflowd/src/server.rs:427`, called at line 460, exists precisely to
pin this ordering.

## Definition of done, all of it

  - the test rewritten around `after_ready` with EXPLICIT synchronisation —
    two threads and a channel, so the interleaving is forced rather than hoped
    for. No sleeps, no timeouts standing in for ordering.
  - CONFIRMED TO FAIL against the pre-fix server.rs. This is the whole point of
    the task. Revert the PR #18 production change locally, run the test, and
    quote the literal failure output; then restore the fix and show it passing.
    A summary that does not contain that failing output has not done the work.
  - `cd kernel && sh ../ops/cargo.sh test` green, and `cd sdk && npm test` green
  - the test must not be flaky: run it at least 20 times in a row and report the
    count. `for i in $(seq 20); do ... ; done`
  - as your LAST action, run `git status --porcelain` and paste it

## Note

This is Rust, not TypeScript, and the seam already exists — the work is the test
and its proof, not new production code. If you find yourself changing
server.rs's behaviour to make the test pass, stop: that is a different task and
the fix is already merged and reviewed.
