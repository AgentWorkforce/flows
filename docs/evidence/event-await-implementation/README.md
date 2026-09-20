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
