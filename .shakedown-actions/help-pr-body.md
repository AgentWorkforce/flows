`flows --help` and `flows -h` now print one usage form per line to stdout and exit 0; unknown options still exit 2. Single-step summaries now say `(1 step)` instead of `(1 steps)`.

Reproduced during the launch shakedown on main a42ca16. This small PR is based directly on main; it does not modify #268/#269 branches.

Validation on this change (full captured output in the shakedown report):

```text
CHECKOUT: /Users/khaliqgant/flows-help-shakedown-0910
COMMAND: npx tsc --noEmit
EXIT: 0

```

```text
CHECKOUT: /Users/khaliqgant/flows-help-shakedown-0910
COMMAND: npx vitest run tests/cli.test.ts
EXIT: 0

 RUN  v2.1.9 /Users/khaliqgant/flows-help-shakedown-0910/packages/sdk

 ✓ tests/cli.test.ts (63 tests) 2691ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 704ms

 Test Files  1 passed (1)
      Tests  63 passed (63)
   Start at  16:21:14
   Duration  3.14s (transform 133ms, setup 0ms, collect 236ms, tests 2.69s, environment 0ms, prepare 34ms)


```

```text
COMMAND: node packages/sdk/dist/cli.js --help
EXIT: 0
STDOUT:
Usage:
flows check [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.yaml|spec.json>
flows run --cloud [--json] [--wait] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>
flows tick start --schedule-id <id> --interval-ms <ms> [--epoch-ms <ms>] [--max-catch-up <n>] [--poll-interval-ms <ms>] [--data-dir <dir>] <spec.json>
flows resume [--json] [--no-spawn] [--data-dir <dir>] <run-id>
flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>

STDERR:

COMMAND: node packages/sdk/dist/cli.js -h
EXIT: 0
STDOUT:
Usage:
flows check [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.yaml|spec.json>
flows run --cloud [--json] [--wait] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>
flows tick start --schedule-id <id> --interval-ms <ms> [--epoch-ms <ms>] [--max-catch-up <n>] [--poll-interval-ms <ms>] [--data-dir <dir>] <spec.json>
flows resume [--json] [--no-spawn] [--data-dir <dir>] <run-id>
flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>

STDERR:

COMMAND: node packages/sdk/dist/cli.js --definitely-invalid
EXIT: 2
STDOUT:

STDERR:
REFUSED [invalid_invocation] Usage:
flows check [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.yaml|spec.json>
flows run --cloud [--json] [--wait] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>
flows tick start --schedule-id <id> --interval-ms <ms> [--epoch-ms <ms>] [--max-catch-up <n>] [--poll-interval-ms <ms>] [--data-dir <dir>] <spec.json>
flows resume [--json] [--no-spawn] [--data-dir <dir>] <run-id>
flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>

```

```text
CWD: /Users/khaliqgant/flows-help-shakedown-0910
COMMAND: node /Users/khaliqgant/flows-help-shakedown-0910/packages/sdk/dist/cli.js run /Users/khaliqgant/flows-shakedown-0910/testdata/shakedown/hello-world.flow.yaml --data-dir /tmp/rfd-96g6toyf
ENV OVERRIDES: {}
EXIT: 0
ELAPSED: 0.249s
STDOUT:
RUN 01M25V99YWG6MCDTKWNG9PB3HK completed (1 step) completionReason: success

STDERR:
WARNING [unprovable_effects] Step "hello" command "printf" resolves, but its effects cannot be proven before execution.


```

```text
CWD: /Users/khaliqgant/flows-help-shakedown-0910
COMMAND: git rev-parse HEAD
EXIT: 0
179092173be91d4e4fcc9245be17371bca08360a

CWD: /Users/khaliqgant/flows-help-shakedown-0910
COMMAND: git ls-remote origin refs/heads/fix/cli-help-shakedown-0910
EXIT: 0
179092173be91d4e4fcc9245be17371bca08360a	refs/heads/fix/cli-help-shakedown-0910


```

`cargo test -p relayflowd` exited 0. Final literal output:

```text

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.16s

     Running tests/subscription_liveness.rs (target/debug/deps/subscription_liveness-9506d11f678a9586)

running 3 tests
test submit_event_upserts_subscription_row_and_sweep_flags_it_stale_after_budget ... ok
test stale_transition_is_journaled_as_subscription_stale_entry_in_the_last_known_run ... ok
test a_fresh_arrival_re_arms_the_latch_and_the_next_silence_can_stale_again ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s

   Doc-tests relayflowd

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```
