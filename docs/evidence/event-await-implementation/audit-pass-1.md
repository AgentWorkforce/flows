# Event-await implementation audit — pass 1

Audited at `ef692235c3064346b5326ca7374392d484bf1b9c` plus the working-tree
fixes recorded below. Scope was every event-await commit after `c8c68315`:
`73f32ad1`, `ee3f3452`, `5742029e`, `d06eabdf`, `c5f54733`, `ec4345a8`, and
`6e8c3cb6`, together with their evidence-only commits.

Fix commit: `3236011f20f918aa347a576426b6530a3e52e107`
(`fix(event-await): preserve durable activity wake recovery`).

## Fixed findings

1. **F1 — immediate event completion was not recoverable.**
   `next_subscription()` could append `wait.completed` and an acknowledgement
   without first appending its `wait.event`. A crash between those records
   made the completion orphaned during fold and could redeliver its frames.
   It now records `wait.event` before a ready-batch completion.

2. **F2 — a fenced overflow of a parked `next()` decoded as an internal
   protocol error.** The overflow close writes a durable completion result
   `{ wake: "overflow" }`; the recovery decoder previously required event
   offsets instead. It now returns the fenced `Wake.overflow` and leaves the
   closed wake stable. The regression exercises the real SQLite journal across
   the fence/restart/close boundary.

3. **F3 — activity wait ids collided at a simulated-clock instant.** They
   were derived from `now_ms`, so two wakes in one millisecond reused an id.
   Wait ids are now a durable per-subscription sequence reconstructed from the
   journal.

4. **F4 — activity cleanup skipped authored validation errors.** A missing
   `done()` or a post-body operation-validation failure left an opened cursor
   live. Those paths now close it with `canceled`. The SDK test no longer uses
   a zero-millisecond timing assumption; it waits for the actual open request.

## Acceptance status and blocker

The local daemon/kernel regressions cover the journal-side cases. The
provider-router portion of acceptance case 11 remains **unimplemented in this
worktree**: `open_subscription()` records `ingress_offset: 0` and the neutral
`{"transport":"local-daemon"}` receipt, while no durable prepared Cloud
binding, generation, ingress log/replay, or recovery cleanup exists here.
The current `event.emit` route is run-local, so it cannot prove a frame that
arrives between external binding preparation and body visibility. This is a
contractual blocker for a full acceptance-11 / production-router claim, not a
kernel substitute. No Cloud credentials, remote configuration, or deployment
was touched.

## Verification

Focused kernel regression, exit 0:

```text
$ cd kernel && zsh -c 'PATH=/Users/khaliqgant/.cargo/bin:$PATH RUSTUP_TOOLCHAIN=local sh ../ops/cargo.sh test -p relayflowd --test event_activities --quiet; audit_rc=$?; printf "EVENT_AWAIT_KERNEL_EXIT=%s\n" "$audit_rc"; exit "$audit_rc"'

running 8 tests
........
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.84s

EVENT_AWAIT_KERNEL_EXIT=0
```

Full kernel workspace, exit 0:

```text
$ cd kernel && PATH=/Users/khaliqgant/.cargo/bin:$PATH RUSTUP_TOOLCHAIN=local sh ../ops/cargo.sh test --workspace

test result: ok. 49 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Focused SDK regression plus test typecheck, exit 0:

```text
$ cd packages/sdk && npm exec vitest -- run tests/authored-activity.test.ts && npm run typecheck:tests

✓ tests/authored-activity.test.ts (9 tests) 69ms
Test Files  1 passed (1)
Tests  9 passed (9)

> @relayflows/sdk@2.0.14 typecheck:tests
> tsc -p tsconfig.tests.json
```

Full surface package, exit 0:

```text
$ cd packages/surface && PATH=/Users/khaliqgant/.bun/bin:$PATH /Users/khaliqgant/.bun/bin/bun run test

Test Files  6 passed (6)
Tests  34 passed (34)
```

The full SDK package command was run with the required shim paths:

```text
$ cd packages/sdk && export PATH=/Users/khaliqgant/.cargo/bin:/Users/khaliqgant/.bun/bin:$PATH; export RUSTUP_TOOLCHAIN=local; npm test
EVENT_AWAIT_SDK_FULL_EXIT=1
```

Its failure is outside this slice's source changes and is recorded rather than
masked: 1,687 tests passed and 18 were skipped; two environment preconditions
failed. `tests/authored-node-runtime.test.ts` pins Bun `1.4.0`, but the
available executable reports `1.4.2`; `tests/mcp.test.ts` falls back to the
absent `kernel/target/release/relayflowd` rather than the wrapper's debug
binary. Literal checks:

```text
$ PATH=/Users/khaliqgant/.bun/bin:$PATH bun --version
1.4.2
$ test -x kernel/target/release/relayflowd; printf 'RELEASE_RELAYFLOWD_EXISTS=%s\n' "$?"
RELEASE_RELAYFLOWD_EXISTS=1
```

The changed files pass `git diff --check` (exit 0). `cargo fmt --check` could
not run because this installed toolchain has no `fmt` component:

```text
$ cd kernel && sh ../ops/cargo.sh fmt --all -- --check
error: no such command: `fmt`
```
