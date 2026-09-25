# Event-await verification, 2026-09-19

This replaces the earlier implementation notes and inconsistent test transcript.
The current protocol and its Cloud integration boundary are specified in
[EVENT-AWAIT.md](../../EVENT-AWAIT.md).

The handshake is `subscription.open` → `subscription.prepared` → Cloud persists
its binding/cursor → `subscription.activate` → `subscription.opened`.
`subscription.park` releases the root lease on a durable wait. A local router
adapter supplies events for the CLI probe; it does not establish a deployed
Cloud provider path. Cloud binding/authorization, wake scheduling, and epoch
compaction acceptance remain unverified. No complete acceptance claim is made.

## Kernel parking and replay

```text
cwd: /tmp/flows-pr-followup/pr441/kernel
$ cargo test --locked -p relayflowd --test event_activity_parking
   Compiling relayflowd v0.1.0 (/tmp/flows-pr-followup/pr441/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.48s
     Running tests/event_activity_parking.rs (target/debug/deps/event_activity_parking-d8e0d6eeb684776f)

running 3 tests
test replay_keeps_each_acknowledged_batch_addressable_by_body_call_ordinal ... ok
test activation_and_delivery_racing_the_lease_handoff_are_not_lost ... ok
test parked_attempt_survives_restart_and_only_a_ready_subscription_redispatches_it ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s


exit status: 0

```

## SDK types and targeted integration/runtime tests

```text
cwd: /tmp/flows-pr-followup/pr441/packages/sdk
$ sh -c 'export PATH=/tmp/flows-pr-cleanup/toolchain/node_modules/node/bin:/tmp/flows-pr-cleanup/toolchain/node_modules/.bin:$PATH RELAYFLOWD_BIN=/tmp/flows-pr-followup/pr441/kernel/target/debug/relayflowd; npm run typecheck && npm run typecheck:tests && npx vitest run tests/authored-activity.test.ts tests/activity-preflight.test.ts tests/live-event-activities.test.ts tests/event-await-cli.test.ts tests/authored-root.test.ts tests/authored-human.test.ts tests/authored-node-runtime.test.ts tests/journal-client.test.ts'

> @relayflows/sdk@2.0.22 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.22 typecheck:tests
> tsc -p tsconfig.tests.json


 RUN  v2.1.9 /tmp/flows-pr-followup/pr441/packages/sdk

 ✓ tests/journal-client.test.ts (15 tests) 90ms
 ✓ tests/activity-preflight.test.ts (1 test) 9ms
 ✓ tests/authored-activity.test.ts (13 tests) 93ms
 ✓ tests/authored-human.test.ts (13 tests) 115ms
 ✓ tests/authored-root.test.ts (12 tests) 174ms
 ✓ tests/live-event-activities.test.ts (2 tests) 186ms
 ✓ tests/event-await-cli.test.ts (1 test) 9603ms
   ✓ parks, restarts, and replays two event wakes through the actual CLI 9602ms
 ✓ tests/authored-node-runtime.test.ts (14 tests) 73430ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > serializes the immutable prepared binding facts through the Node and CLI boundary 1284ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > awaits agent plus three run steps and resumes without repeating effects 1899ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > accepts a predicate-gated flow: the `<step>.gate` child is journaled, verified, and not counted as an authored step 1918ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > parks an f.human across the IPC boundary, answers it, and resumes the Node body with the answer 2976ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > stops on parent SIGKILL and replays completed children before success 2388ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > stops on parent SIGTERM and replays completed children before success 2502ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > stops on parent blocked-SIGKILL and replays completed children before success 2469ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > stops on parent SIGKILL and replays completed children before declined 2294ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > refuses unawaited rather than reporting terminal success 13458ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > refuses manual then rather than reporting terminal success 14316ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > loads captured graph bytes before preserving the unsupported-use refusal 13186ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > rejects a forged result frame without durable completion 12851ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > refuses missing Node before body effects or root admission 412ms
   ✓ Bun 1.4.0 standalone → native Node authored lifecycle > refuses an old Node candidate before body effects 462ms

 Test Files  8 passed (8)
      Tests  71 passed (71)
   Start at  20:41:12
   Duration  74.60s (transform 1.12s, setup 0ms, collect 6.05s, tests 83.70s, environment 2ms, prepare 545ms)


exit status: 0

```

## Actual CLI restart and replay probe

```text
cwd: /tmp/flows-pr-followup/pr441
$ env RELAYFLOWD_BIN=/tmp/flows-pr-followup/pr441/kernel/target/debug/relayflowd /tmp/flows-pr-cleanup/toolchain/node_modules/node/bin/node packages/sdk/tests/fixtures/event-await-cli-probe.mjs /tmp/flows-pr-followup/pr441
{"args":["run","await.flow.ts","--input","{}"],"status":4,"stdout":"{\"ok\":false,\"command\":\"run\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"path\":\"await.flow.ts\",\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"eventTypes\":[\"e2e_event\"],\"stream\":\"subscription/activity-1\",\"settleMs\":0,\"idleMs\":3600000,\"deadlineAtMs\":1789962028741,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for activation.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"activation\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741,\"eventTypes\":[\"e2e_event\"],\"settleMs\":0,\"idleMs\":3600000,\"includeSelf\":false},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for activation.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for event_wait.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"event_wait\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for event_wait.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for event_wait.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"event_wait\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for event_wait.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":4,"stdout":"{\"ok\":false,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"subscription_suspended\",\"message\":\"Flow \\\"event-await-cli\\\" suspended for event_wait.\"}],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"status\":\"suspended\",\"suspension\":{\"kind\":\"event_wait\",\"subscriptionId\":\"activity-1\",\"stream\":\"subscription/activity-1\",\"deadlineAtMs\":1789962028741},\"completedSteps\":0}\n","stderr":"WARNING [subscription_suspended] Flow \"event-await-cli\" suspended for event_wait.\n"}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":0,"stdout":"{\"ok\":true,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"completedSteps\":4,\"status\":\"completed\",\"completionReason\":\"success\"}\n","stderr":""}
{"args":["resume","01M2YEDANJN68QR2M0HYGBQSC5"],"status":0,"stdout":"{\"ok\":true,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[],\"runId\":\"01M2YEDANJN68QR2M0HYGBQSC5\",\"socketPath\":\"/run/user/1000/relayflowd-048d675f69db.sock\",\"completedSteps\":4,\"status\":\"completed\",\"completionReason\":\"success\"}\n","stderr":""}
E2E_PASS: repeated park, SIGKILL/restart, two wakes replayed in order, deduped delivery, exactly-once child effects, zero crash retries

exit status: 0

```

## Review regressions: event isolation and close reasons

```text
cwd: /tmp/flows-pr-followup/pr441/kernel
$ cargo test --locked -p relayflowd --test event_activity_parking --test event_activities
   Compiling relayflowd v0.1.0 (/tmp/flows-pr-followup/pr441/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.60s
     Running tests/event_activities.rs (target/debug/deps/event_activities-ed1739dfa94f36b5)

running 11 tests
test prepared_open_response_replays_the_immutable_binding_snapshot ... ok
test exact_deadline_tie_wins_and_reports_unread_range ... ok
test cancel_closes_an_open_activity_before_the_terminal_run_record ... ok
test overflow_of_a_parked_next_returns_overflow_after_recovery ... ok
test accepted_append_is_buffered_deduplicated_and_survives_a_restart_before_next ... ok
test idle_wait_is_durable_and_fires_without_an_event ... ok
test immediate_event_wakes_have_durable_distinct_wait_boundaries ... ok
test normal_wake_is_not_acknowledged_until_the_following_next ... ok
test prepared_binding_stays_invisible_across_a_crash_until_activation_then_next_suspends ... ok
test remaining_event_await_acceptance_cases_use_the_real_journal ... ok
test overflow_closes_before_the_1001st_unread_frame_and_recovery_never_reopens_it ... ok

test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.73s

     Running tests/event_activity_parking.rs (target/debug/deps/event_activity_parking-d8e0d6eeb684776f)

running 4 tests
test replay_keeps_each_acknowledged_batch_addressable_by_body_call_ordinal ... ok
test intentional_close_cancels_the_pending_pull_without_claiming_a_timeout ... ok
test activation_and_delivery_racing_the_lease_handoff_are_not_lost ... ok
test parked_attempt_survives_restart_and_only_a_ready_subscription_redispatches_it ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s


exit status: 0
```

## Build provenance and cleanup regression

The original targeted SDK run followed this build. The later cleanup regression
command also rebuilds the SDK before testing it.

```text
cwd: /tmp/flows-pr-followup/pr441/kernel
$ sh -c 'cargo build --locked -p relayflowd && npm run build --prefix ../packages/sdk'
   Compiling relayflowd v0.1.0 (/tmp/flows-pr-followup/pr441/kernel/relayflowd)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.34s

> @relayflows/sdk@2.0.22 build
> tsc && node scripts/make-cli-executable.mjs


exit status: 0
```

```text
cwd: /tmp/flows-pr-followup/pr441/kernel
$ cargo build --locked -p relayflowd
   Compiling relayflowd v0.1.0 (/tmp/flows-pr-followup/pr441/kernel/relayflowd)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.16s

exit status: 0
```

```text
cwd: /tmp/flows-pr-followup/pr441/packages/sdk
$ sh -c 'npm run build && npx vitest run tests/authored-activity.test.ts'

> @relayflows/sdk@2.0.22 build
> tsc && node scripts/make-cli-executable.mjs


 RUN  v2.1.9 /tmp/flows-pr-followup/pr441/packages/sdk

 ✓ tests/authored-activity.test.ts (15 tests) 79ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  20:56:03
   Duration  1.13s (transform 467ms, setup 0ms, collect 837ms, tests 79ms, environment 0ms, prepare 78ms)


exit status: 0
```

## Corrupt journal rejection

```text
cwd: /tmp/flows-pr-followup/pr441/kernel
$ cargo test --locked -p relayflowd --test event_activity_corruption --test event_activity_parking --test event_activities
   Compiling relayflowd v0.1.0 (/tmp/flows-pr-followup/pr441/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.34s
     Running tests/event_activities.rs (target/debug/deps/event_activities-ed1739dfa94f36b5)

running 11 tests
test prepared_open_response_replays_the_immutable_binding_snapshot ... ok
test cancel_closes_an_open_activity_before_the_terminal_run_record ... ok
test exact_deadline_tie_wins_and_reports_unread_range ... ok
test overflow_of_a_parked_next_returns_overflow_after_recovery ... ok
test accepted_append_is_buffered_deduplicated_and_survives_a_restart_before_next ... ok
test idle_wait_is_durable_and_fires_without_an_event ... ok
test prepared_binding_stays_invisible_across_a_crash_until_activation_then_next_suspends ... ok
test normal_wake_is_not_acknowledged_until_the_following_next ... ok
test immediate_event_wakes_have_durable_distinct_wait_boundaries ... ok
test remaining_event_await_acceptance_cases_use_the_real_journal ... ok
test overflow_closes_before_the_1001st_unread_frame_and_recovery_never_reopens_it ... ok

test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.78s

     Running tests/event_activity_corruption.rs (target/debug/deps/event_activity_corruption-e16548e9ab56b153)

running 3 tests
test a_completed_event_range_cannot_replay_with_missing_frames ... ok
test malformed_stream_frames_fail_replay_and_future_append ... ok
test malformed_deadline_range_is_an_error_while_null_is_an_empty_range ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

     Running tests/event_activity_parking.rs (target/debug/deps/event_activity_parking-d8e0d6eeb684776f)

running 4 tests
test intentional_close_cancels_the_pending_pull_without_claiming_a_timeout ... ok
test replay_keeps_each_acknowledged_batch_addressable_by_body_call_ordinal ... ok
test activation_and_delivery_racing_the_lease_handoff_are_not_lost ... ok
test parked_attempt_survives_restart_and_only_a_ready_subscription_redispatches_it ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s


exit status: 0
```

## CLI startup and unchanged watcher checks

The activity checker now loads only for authored TypeScript checks. These are
one-shot import measurements, not a statistical benchmark. The watcher test
limits and assertions are unchanged.

```text
cwd: /tmp/flows-pr-followup/pr441/packages/sdk
$ /tmp/flows-pr-cleanup/toolchain/node_modules/node/bin/node --input-type=module -e 'const start = performance.now(); await import("./dist/cli.js"); console.log(JSON.stringify({cliImportMs: performance.now() - start, rssBytes: process.memoryUsage().rss}));'
{"cliImportMs":480.42877,"rssBytes":172797952}

exit status: 0
```

```text
cwd: /tmp/flows-pr-followup/pr441/packages/sdk
$ /tmp/flows-pr-cleanup/toolchain/node_modules/node/bin/node --input-type=module -e 'const start = performance.now(); await import("./dist/cli.js"); console.log(JSON.stringify({cliImportMs: performance.now() - start, rssBytes: process.memoryUsage().rss}));'
{"cliImportMs":261.441739,"rssBytes":121061376}

exit status: 0
```

```text
cwd: /tmp/flows-pr-followup/pr441/packages/sdk
$ sh -c 'export PATH=/tmp/flows-pr-cleanup/toolchain/node_modules/node/bin:/tmp/flows-pr-cleanup/toolchain/node_modules/.bin:$PATH; npm run build && npm run typecheck && npx vitest run tests/cli-watch.test.ts tests/activity-preflight.test.ts'

> @relayflows/sdk@2.0.22 build
> tsc && node scripts/make-cli-executable.mjs


> @relayflows/sdk@2.0.22 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


 RUN  v2.1.9 /tmp/flows-pr-followup/pr441/packages/sdk

 ✓ tests/activity-preflight.test.ts (1 test) 9ms
 ✓ tests/cli-watch.test.ts (10 tests) 12411ms
   ✓ flows check --watch > rechecks syntax errors, clears once, and returns the last refusal on Ctrl-C 958ms
   ✓ flows check --watch > streams JSON lines without ANSI, recovers after atomic saves, and exits zero after repair 1339ms
   ✓ flows check --watch > coalesces 20 concurrent saves into at most two rechecks 1516ms
   ✓ flows check --watch > watches transitive relative use imports, cycles, and nearest config changes 1815ms
   ✓ flows check --watch > refreshes the import graph and notices missing imports being created 1860ms
   ✓ flows check --watch > reloads authored TypeScript instead of reusing the first imported definition 1418ms
   ✓ flows check --watch > detects a nearer config appearing and falls back after it is deleted 1368ms
   ✓ flows check --watch > keeps watching after the target is deleted and recreated 1361ms
   ✓ flows check --watch > queues changes during a slow check without overlapping checks 772ms

 Test Files  2 passed (2)
      Tests  11 passed (11)
   Start at  21:23:28
   Duration  13.83s (transform 765ms, setup 0ms, collect 1.98s, tests 12.42s, environment 0ms, prepare 104ms)


exit status: 0
```
