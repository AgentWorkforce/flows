# Event-await local implementation evidence

Implementation commit: `ec4345a8c474bbe16b9727e5a0d2dd874e399569`.

## Scope and acceptance map

`kernel/relayflowd/tests/event_activities.rs` is the deterministic SQLite
journal harness. It covers cases 1–8 and 10–15 from `docs/EVENT-AWAIT.md`;
case 9 is the SDK preflight test named below. The live SDK test uses the real
daemon socket and includes an actual `SIGKILL` / restart boundary after
`stream.appended`.

| Acceptance case | Test |
| --- | --- |
| 1, 3–5, 7, 8, 10–12, 15 | `remaining_event_await_acceptance_cases_use_the_real_journal` |
| 2, 6 | `accepted_append_is_buffered_deduplicated_and_survives_a_restart_before_next` (plus the SDK SIGKILL test) |
| 8 | `cancel_closes_an_open_activity_before_the_terminal_run_record` |
| 9 | `packages/sdk/tests/activity-preflight.test.ts` |
| 13 | `exact_deadline_tie_wins_and_reports_unread_range` |
| 14 | `overflow_closes_before_the_1001st_unread_frame_and_recovery_never_reopens_it` |

## Kernel acceptance command

Command (exit 0):

```sh
PATH=/Users/khaliqgant/.relayflows-toolchain/rustup/toolchains/local/bin:$PATH CARGO_HOME=/Users/khaliqgant/.relayflows-toolchain/cargo RUSTUP_HOME=/Users/khaliqgant/.relayflows-toolchain/rustup RUSTUP_TOOLCHAIN=local CARGO_TARGET_DIR=/Users/khaliqgant/.relayflows-toolchain/target/1398563233 /Users/khaliqgant/.relayflows-toolchain/rustup/toolchains/local/bin/cargo test --manifest-path kernel/Cargo.toml -p relayflowd --test event_activities
```

Captured output:

```text
Finished `test` profile [unoptimized + debuginfo] target(s) in 1.35s
Running tests/event_activities.rs (/Users/khaliqgant/.relayflows-toolchain/target/1398563233/debug/deps/event_activities-54b0211a77a95d2a)

running 6 tests
test exact_deadline_tie_wins_and_reports_unread_range ... ok
test cancel_closes_an_open_activity_before_the_terminal_run_record ... ok
test accepted_append_is_buffered_deduplicated_and_survives_a_restart_before_next ... ok
test idle_wait_is_durable_and_fires_without_an_event ... ok
test remaining_event_await_acceptance_cases_use_the_real_journal ... ok
test overflow_closes_before_the_1001st_unread_frame_and_recovery_never_reopens_it ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.99s

EXIT=0
```

## SDK command

Command (exit 0):

```sh
cd packages/sdk && /Users/khaliqgant/.bun/bin/bun run typecheck && /Users/khaliqgant/.bun/bin/bun run build && /Users/khaliqgant/.bun/bin/bun run typecheck:tests && RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/1398563233/debug/relayflowd /Users/khaliqgant/.bun/bin/bun x vitest run tests/authored-activity.test.ts tests/activity-preflight.test.ts tests/live-event-activities.test.ts
```

Captured output:

```text
$ tsc --noEmit && tsc -p tsconfig.type-tests.json
$ tsc && node scripts/make-cli-executable.mjs
$ tsc -p tsconfig.tests.json

 RUN  v2.1.9 /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917/packages/sdk

 ✓ tests/activity-preflight.test.ts (1 test) 6ms
 ✓ tests/authored-activity.test.ts (8 tests) 19ms
 ✓ tests/live-event-activities.test.ts (2 tests) 629ms
   ✓ runs surface f.on through the local daemon event path and journals its buffered wake 570ms

 Test Files  3 passed (3)
      Tests  11 passed (11)
   Start at  08:04:53
   Duration  2.40s (transform 839ms, setup 0ms, collect 4.48s, tests 655ms, environment 0ms, prepare 208ms)

EXIT=0
```

## Surface command

Command (exit 0):

```sh
cd packages/surface && PATH=/Users/khaliqgant/.bun/bin:$PATH /Users/khaliqgant/.bun/bin/bun run test
```

Captured output:

```text
$ bun run build && tsc -p tsconfig.test.json && vitest run
$ tsc

 RUN  v2.1.9 /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917/packages/surface

 ✓ tests/activity.test.ts (1 test) 1ms
 ✓ tests/triggers.test.ts (4 tests) 4ms
 ✓ tests/slack-block-kit.test.ts (5 tests) 3ms
 ✓ tests/provider-triggers.test.ts (3 tests) 4ms
 ✓ tests/flow.test.ts (20 tests) 9ms
 ✓ tests/helpers.snapshot.test.ts (1 test) 475ms
   ✓ regenerates helpers byte-identically from the pinned adapter 475ms

 Test Files  6 passed (6)
      Tests  34 passed (34)
   Start at  08:05:02
   Duration  810ms (transform 189ms, setup 0ms, collect 644ms, tests 495ms, environment 1ms, prepare 583ms)

EXIT=0
```

## Cloud handoff

No Cloud credentials, remote configuration, or deployment was touched. The
repository-owned local adapter deliberately uses `event.emit` with a provider
delivery id and actor, and the kernel records only the tenant-neutral facts.
Production router work still outside this repository is:

1. Before acknowledging `subscription.open`, durably create the fenced Cloud
   binding for `(run_id, subscription_id, generation, ingress_offset)` with
   the installation, canonical resource scope, authorization snapshot, event
   types, pattern, and run identity. Persist that binding receipt and ingress
   offset in `subscription.opened`.
2. On recovery, remove a prepared binding lacking `subscription.opened`; for
   an opened binding replay ingress strictly after its saved offset before
   making it visible. If the binding is `closing: overflow`, submit the same
   idempotent overflow-close command and never reopen or replay it.
3. Authenticate every provider frame against the bound installation and
   canonical scope, apply the actor/self filter, and pass its provider delivery
   id to the per-subscription journal sequencer. A user pattern must not widen
   installation or resource authorization.
4. On a would-exceed frame, first durably fence the Cloud binding and refuse
   later appends; then submit the overflow close to the same sequencer as
   appends and timer claims. Remove the binding only after the close commits.

There is no local blocker. The only intentionally unimplemented portion is
that Cloud-owned provider binding/ingress handoff above; its absence is why the
local acceptance case proves the journal side of the post-open handoff rather
than claiming a real provider-router crash test.
