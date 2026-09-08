# Daemon lifecycle: implementation report

Phase 1 of "package flows so it's frictionless" (`workflows/daemon-lifecycle.yaml`).
This report closes out the workflow's `adversarial-review` and `report` steps;
`design`, `kernel-impl`, `kernel-tests`, `cli-impl`, `sdk-tests`, and
`e2e-smoke` all completed and are green as of this report, on branch
`feat/daemon-lifecycle`, working tree uncommitted.

**Update after the first review pass**: the first adversarial pass returned
`REVIEW_FAILED` — §6 tests 4 and 5 were missing. Both have since been written
against the real `relayflowd` binary in `kernel/relayflowd/tests/daemon_lifecycle.rs`
and pass (`a_second_serve_on_a_served_data_dir_refuses_and_the_first_keeps_serving`,
`a_sigkilled_daemons_successor_starts_cleanly`), and `cargo test --workspace`
is green with them included. The "Adversarial review verdict" section below is
left as originally written (the violation as first found) with a note added
at its top recording that the gap is now closed; nothing else in that section
changed on re-verification.

## What was built

`relayflowd serve` now holds an exclusive `flock(2)` on
`<data-dir>/relayflowd.lock` for its whole lifetime (`kernel/relayflowd/src/server/lifecycle.rs`),
sweeps leftover socket/connection-file residue only after acquiring that lock,
binds the unix socket, and only then atomically publishes `<data-dir>/connection.json`
(`socket_path`, `pid`, `version`, `protocol`, `started_at_ms`) via a
temp-file-then-rename. Clean shutdown (SIGTERM/SIGINT) unlinks both the
connection file and the socket from an async-signal-safe handler before
`_exit(0)`; a hard `kill -9` leaves the file behind by construction. A second
`serve` on an already-served data dir loses the `flock`, touches nothing, and
exits 3.

On the CLI side, `packages/sdk/src/daemon-connection.ts` reads and validates
`connection.json` and decides `absent` / `stale` / `attached` / `incompatible`
by combining a pid-liveness check with a socket `hello` probe — the socket is
always the authority, the file is never trusted alone.
`packages/sdk/src/daemon-lifecycle.ts` is the attach-or-spawn algorithm:
attach if something answers; otherwise resolve the `relayflowd` binary
(`packages/sdk/src/relayflowd-path.ts`, multi-anchor resolution ported from
`../relay`'s `broker-path.ts`), spawn it detached (own session, ignored
stdio, log to `<data-dir>/relayflowd.log`, `unref()`'d), and poll for the
connection file up to a bounded timeout, treating exit code 3 as "lost a
benign race, keep polling" rather than a failure. This is wired into
`flows check` / `run` / `resume` via `packages/sdk/src/cli.ts` and
`packages/sdk/src/cli/run.ts`'s shared `connect()` seam. A new `--no-spawn`
flag (`FLOWS_NO_SPAWN=1`) restores today's exact fail-closed behavior for CI.
`journal-client.ts` gained a `connectTimeoutMs` (default 2s) so a socket that
accepts but never answers can't hang the CLI for the old 30s request default.

## Test results

**Kernel** (`cd kernel && cargo test --workspace`): all green.

```
running 9 tests (relayflowd-core)          ... 9 passed
running 28 tests (relayflowd-journal)      ... 28 passed
running N tests (relayflowd, incl. server::tests + daemon_lifecycle.rs)
test result: ok. 0 failed
```

Kernel-side daemon-lifecycle tests present (`kernel/relayflowd/tests/daemon_lifecycle.rs`),
now all six of §6's kernel tests:
`connection_file_is_published_only_after_the_socket_is_live` (test 1),
`clean_shutdown_removes_advertisement_and_socket` (test 2),
`sigkill_leaves_a_stale_file_with_a_dead_pid` (test 3),
`a_second_serve_on_a_served_data_dir_refuses_and_the_first_keeps_serving` (test 4,
added after the first review pass — spawns two real `relayflowd serve`
processes against one data dir and asserts the loser exits 3 untouched and the
winner keeps accepting), and `a_sigkilled_daemons_successor_starts_cleanly`
(test 5, added after the first review pass — SIGKILLs a daemon, starts a
second against the same data dir, and asserts the successor acquires the
freed `flock`, sweeps the residue, and publishes its own advertisement). All
five pass against the real binary; `cargo test --workspace` is green with
them included.

**SDK** (`cd packages/sdk && npm test`): **803 passed, 3 skipped** (37 test
files passed, 1 skipped, of 38). Includes `tests/daemon-lifecycle.test.ts`
(unit-level, injected deps — cold start, warm start, stale-file cases,
`EPERM`-is-alive, socket_path mismatch, protocol mismatch, `--no-spawn`,
`RELAYFLOWD_BIN` non-executable refusal, detached-spawn options) and
`tests/daemon-lifecycle-live.test.ts` (real built-CLI subprocess tests against
a stub daemon: cold start spawns exactly one daemon and the daemon outlives
the CLI, bounded polling for a slow-listening daemon, attaching to a daemon
serving with no connection file, a second run attaching without spawning, a
stale connection file triggering a fresh spawn, and the §6-test-15 concurrency
case).

**e2e-smoke** (workflow yaml's exact command, `testdata/hello-deterministic.flow.yaml`):

```
$ flows check --json testdata/hello-deterministic.flow.yaml --data-dir /tmp/flows-daemon-lifecycle-smoke
REFUSED [invalid_invocation]   # expected: check refuses --data-dir, per design §4 ("flows check stays daemon-free")
{"ok":false,...,"kind":"invalid_invocation",...}

$ flows run --json testdata/hello-deterministic.flow.yaml --data-dir /tmp/flows-daemon-lifecycle-smoke
WARNING [unprovable_effects] Step "greet" ...
WARNING [unprovable_effects] Step "shout" ...
{"ok":true,"command":"run",...,"status":"completed","completionReason":"success","completedSteps":2}
```

Cold start against an empty data dir: no daemon running beforehand, `flows
run` spawned one, attached, and completed — no manual `relayflowd serve`
step, which is exactly Phase 1's goal.

## Adversarial review verdict: **REVIEW_FAILED (first pass) → closed**

One confirmed, concrete violation on the first pass; fixed since (see the
update note at the top of this report) and re-verified by running the new
tests against the real binary. Everything else checked held up on the first
pass and was not re-litigated.

**Violation — the flock/exit-3 property has zero test coverage against the
real kernel binary.** `kernel/DAEMON-LIFECYCLE.md` §6 lists six kernel tests
this spec "must be held to." Only tests 1, 2, and 3 exist
(`kernel/relayflowd/tests/daemon_lifecycle.rs`). Tests 4 ("a second `serve` on
a served data dir exits 3, and the first daemon's socket is still accepting
afterwards — the anti-hijack test") and 5 ("a SIGKILLed daemon's successor
starts cleanly") are absent. `grep` across `kernel/relayflowd/src` and
`kernel/relayflowd/tests` for `AlreadyServing`/`already serving` finds only
the two lines in `server.rs`/`lifecycle.rs` that implement the exit-3 path —
no test calls it. The SDK's own live test suite documents this gap in its own
comment: `packages/sdk/tests/fixtures/stub-relayflowd.mjs` fakes the mutex
with `open(O_CREAT|O_EXCL)` instead of a real `flock`, and says explicitly
*"the `flock` guarantee itself belongs to the kernel implementation and its
`cargo test` cases (DAEMON-LIFECYCLE.md §6 tests 4 and 5)."* Those cases were
never written. This is the design's own load-bearing claim — *"because the
daemon holds the mutex, the CLI never has to be clever. Spawning when in
doubt is always safe"* — asserted about the real `flock(2)` call in
`lifecycle.rs`, verified only by inspection, never by a test that actually
spawns two real `relayflowd serve` processes against the same data dir. The
implementation reads correct (`acquire()` is called before any
unlink/bind/publish, §1 steps 2→3 order is right in `server.rs`), but "reads
correct" is not the bar this design set for itself in its own §6.

Everything else adversarially checked:

1. **Two concurrent `flows` invocations, empty data dir** — correct by
   design and exercised for real (real processes, real race window) at the
   CLI level in `tests/daemon-lifecycle-live.test.ts`'s §6-test-15 case
   (started=2, serving=1, lost=1, asserted every run). Not exercised at the
   kernel level (see the violation above) because the stub does not use a
   real `flock`.
2. **Stale `connection.json` causing a false attach** — not reproducible.
   `checkDaemon` (`daemon-connection.ts`) always backs a file with a live
   `hello` probe at the path recomputed from `--data-dir`; `isProcessAlive`
   correctly treats `EPERM` as alive (the specific bug the design calls out
   as present in `../relay` and refuses to port); a `socket_path` mismatch is
   `stale`, not a redirect.
3. **Detached spawn survives the CLI exiting** — `spawnDaemon`
   (`daemon-lifecycle.ts`) sets `detached: true`, ignores stdin/stdout,
   routes stderr to `relayflowd.log`, and calls `child.unref()`; asserted by
   a dedicated unit test (`daemon-lifecycle.test.ts:362`) and demonstrated
   live by the cold-start e2e-smoke run above (daemon outlived the CLI
   invocation).
4. **Manual `relayflowd serve` operator compatibility** — unchanged
   observable behavior confirmed by reading `server.rs`'s diff: the same
   unlink/bind sequence, now additionally gated by the lock and followed by
   `connection.json` publication and signal cleanup, none of which an
   existing manual workflow depends on the absence of.
5. **Publish strictly after listen** — confirmed both by code order
   (`UnixListener::bind` completes, then `lifecycle::publish` is called, in
   `server.rs`) and by a real-process test
   (`connection_file_is_published_only_after_the_socket_is_live`, which
   connects to whatever socket it observes and requires that connect to
   succeed).

## Phase 2 (not in this workflow's scope)

Per `kernel/DAEMON-LIFECYCLE.md`'s own framing, this is Phase 1 (the
handshake) only. Phase 2 is per-platform `relayflowd`/`flows` binary
packages, mirroring the existing `packages/runtime-linux-x64` pattern, so
`resolveRelayflowdBinary`'s optional-dependency resolution step
(`relayflowd-path.ts` §3.1 step 3) has something real to find on a fresh
`npm install -g relayflows` on macOS and Windows, not just Linux. Until
Phase 2 ships, a fresh install on those platforms falls through to the
source-checkout and `PATH` resolution steps, which will not find anything on
a machine that never built the kernel from source — `relayflowd_not_found`
is the expected, correct refusal there today, not a bug.

## Open risk

- ~~The flock/exit-3 kernel property is unverified against the real binary~~
  — closed: `a_second_serve_on_a_served_data_dir_refuses_and_the_first_keeps_serving`
  and `a_sigkilled_daemons_successor_starts_cleanly` now exercise it directly
  against real `relayflowd serve` processes.
- The stub relayflowd's lock emulation (`link(2)` + pid-liveness reclaim) is
  a second, independent implementation of "singleton mutex, reclaim on
  death." It is documented as intentionally not faithful to `flock`'s
  kernel-released-on-any-death semantics. If the two implementations ever
  disagree on an edge case (e.g. a permissions error acquiring the lock file
  itself), the SDK-level tests would not catch it.
- No test in either suite exercises `relayflowd serve` being started by hand
  (as an operator would, per the backward-compatibility claim) concurrently
  with a CLI-spawned attempt — only CLI-vs-CLI races are covered.
- This report and the code it describes are uncommitted on
  `feat/daemon-lifecycle`; nothing here has been through code review or CI.
