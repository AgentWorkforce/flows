# Event-await implementation audit — pass 2

Audited the local EVENT-AWAIT sequence from `73f32ad1` through
`c9cb5de2`, including each implementation, test, and evidence commit:
`73f32ad1`, `ee3f3452`, `5742029e`, `d06eabdf`, `c5f54733`, `ec4345a8`,
`6e8c3cb6`, `3236011f`, and `c9cb5de2`.

Implementation fix commit: `651d07a3a2d818782f2f453173d3f001626be511`
(`fix(event-await): retain normal wakes until acknowledged`).

The source contract was `docs/EVENT-AWAIT.md`, acceptance cases 1–15, read
with RFC-0001 and the repository AGENTS rules before this audit.

## Fixed findings

1. **F5 — a normal wake could be lost in the daemon-to-body hand-off.**
   `next_subscription()` committed `subscription.acknowledged` before its
   socket response. A daemon death after that append and before the response
   permanently advanced the unread cursor although the body had not observed
   the wake. Normal wakes now remain durable until the following `next()`
   supplies the previous wait receipt. The daemon returns that opaque receipt
   only on its additive protocol result; `Activity.next()` keeps it internal.
   Recovery also receives the durable receipt rather than guessing a sequence.

2. **F6 — overflow settled an active wait with the wrong journal reason.**
   EVENT-AWAIT §5.3 requires the overflow close to settle it as
   `event_received` with the overflow result. The implementation wrote
   `timeout`. Overflow now writes `event_received`; deadline remains `timeout`.

3. **F7 — the live regression could silently exercise a stale daemon.**
   `live-event-activities.test.ts` contained a hard-coded cargo target path.
   It now derives this worktree's target using the same `cksum` convention as
   `ops/cargo.sh`. The tested daemon was
   `/Users/khaliqgant/.relayflows-toolchain/target/1445268772/debug/relayflowd`.

New regressions pin the delayed acknowledgement/restart boundary, recovered
receipt delivery, overflow completion reason, SDK receipt propagation, and the
current-worktree live daemon path.

## Remaining contractual blocker

Acceptance case 11 is still not implementable in this worktree. The local
daemon records `ingress_offset: 0` and a `local-daemon` receipt; it does not
contain the Cloud durable prepared binding, binding generation, ingress log,
post-offset replay, or prepared-binding recovery cleanup that EVENT-AWAIT §5–6
requires. This audit did not represent local ingress as a Cloud-router proof.
No credentials, remote configuration, deployment, push, or merge was used.

## Verification

Focused kernel regression (exit 0):

```text
$ cd kernel && PATH=/Users/khaliqgant/.cargo/bin:$PATH RUSTUP_TOOLCHAIN=local sh ../ops/cargo.sh test -p relayflowd --test event_activities --quiet; audit_rc=$?; printf 'EVENT_AWAIT_AUDIT_KERNEL_EXIT=%s\n' "$audit_rc"; exit "$audit_rc"

running 9 tests
.........
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.91s

EVENT_AWAIT_AUDIT_KERNEL_EXIT=0
```

Focused SDK activity, live-current-daemon, and test typecheck (exit 0):

```text
$ cd packages/sdk && npm exec vitest -- run tests/authored-activity.test.ts tests/live-event-activities.test.ts && npm run typecheck:tests; audit_rc=$?; printf 'EVENT_AWAIT_AUDIT_SDK_NARROW_EXIT=%s\n' "$audit_rc"; exit "$audit_rc"

✓ tests/authored-activity.test.ts (10 tests) 71ms
✓ tests/live-event-activities.test.ts (2 tests) 180ms
Test Files  2 passed (2)
Tests  12 passed (12)

> @relayflows/sdk@2.0.14 typecheck:tests
> tsc -p tsconfig.tests.json

EVENT_AWAIT_AUDIT_SDK_NARROW_EXIT=0
```

The live test was then run without an override, proving its repaired target
selection (exit 0):

```text
$ cd packages/sdk && npm exec vitest -- run tests/live-event-activities.test.ts && npm run typecheck:tests; audit_rc=$?; printf 'EVENT_AWAIT_AUDIT_SDK_LIVE_CURRENT_DAEMON_EXIT=%s\n' "$audit_rc"; exit "$audit_rc"

✓ tests/live-event-activities.test.ts (2 tests) 164ms
Test Files  1 passed (1)
Tests  2 passed (2)

> @relayflows/sdk@2.0.14 typecheck:tests
> tsc -p tsconfig.tests.json

EVENT_AWAIT_AUDIT_SDK_LIVE_CURRENT_DAEMON_EXIT=0
```

Full kernel workspace (exit 0; literal terminal summary):

```text
$ cd kernel && PATH=/Users/khaliqgant/.cargo/bin:$PATH RUSTUP_TOOLCHAIN=local sh ../ops/cargo.sh test --workspace --quiet; audit_rc=$?; printf 'EVENT_AWAIT_AUDIT_KERNEL_WORKSPACE_EXIT=%s\n' "$audit_rc"; exit "$audit_rc"

running 49 tests
.................................................
test result: ok. 49 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.58s

running 40 tests
........................................
test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 37.16s

running 9 tests
.........
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 11.23s

running 65 tests
.................................................................
test result: ok. 65 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.62s

EVENT_AWAIT_AUDIT_KERNEL_WORKSPACE_EXIT=0
```

Full surface package (exit 0):

```text
$ cd packages/surface && PATH=/Users/khaliqgant/.bun/bin:$PATH /Users/khaliqgant/.bun/bin/bun run test; audit_rc=$?; printf 'EVENT_AWAIT_AUDIT_SURFACE_FULL_EXIT=%s\n' "$audit_rc"; exit "$audit_rc"

Test Files  6 passed (6)
Tests  34 passed (34)

EVENT_AWAIT_AUDIT_SURFACE_FULL_EXIT=0
```

Full SDK package suite was run against the current daemon and exited 1 for
two environment-only preconditions, not an event-await failure. Literal final
output was:

```text
$ cd packages/sdk && export PATH=/Users/khaliqgant/.cargo/bin:/Users/khaliqgant/.bun/bin:$PATH; export RUSTUP_TOOLCHAIN=local; npm test; audit_rc=$?; printf 'EVENT_AWAIT_AUDIT_SDK_FULL_EXIT=%s\n' "$audit_rc"; exit "$audit_rc"

FAIL  tests/authored-node-runtime.test.ts > Bun 1.4.0 standalone → native Node authored lifecycle
AssertionError: expected '1.4.2' to be '1.4.0'

FAIL  tests/mcp.test.ts > authored MCP effects against the real kernel
Error: journal client: connect failed: connect ENOENT .../relayflowd-4bccca3feb68.sock

Error: spawn .../kernel/target/release/relayflowd ENOENT

Test Files  2 failed | 106 passed | 2 skipped (110)
Tests  1688 passed | 18 skipped (1706)
Errors  1 error

EVENT_AWAIT_AUDIT_SDK_FULL_EXIT=1
```

The command's interactive progress output was terminal-truncated by the test
runner transport; the exit code and final failure output above are the exact
captured terminal result. The focused and live event-await regressions above
passed in that same worktree.

Diff check (exit 0):

```text
$ git diff --check; audit_rc=$?; printf 'EVENT_AWAIT_AUDIT_DIFF_CHECK_EXIT=%s\n' "$audit_rc"; exit "$audit_rc"
EVENT_AWAIT_AUDIT_DIFF_CHECK_EXIT=0
```
