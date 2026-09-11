# Local validation — spec F read slice

Captured on 2026-09-11. This is not Gate 5 acceptance evidence: writes, fresh
DB creation, CLI-only access, and agent context injection remain deferred.
No PR or remote CI claim is made; the lead owns that handoff.

## Focused memory and refusal coverage

Command (packages/sdk):

```sh
./node_modules/.bin/vitest run tests/f-memory.test.ts tests/preflight.test.ts
```

Exit 0, captured output:

```text

 RUN  v2.1.9 /Users/khaliqgant/flows-spec-F-memory/packages/sdk

 ✓ tests/preflight.test.ts (27 tests) 24ms
 ✓ tests/f-memory.test.ts (7 tests) 732ms

 Test Files  2 passed (2)
      Tests  34 passed (34)
   Start at  13:36:32
   Duration  1.11s (transform 176ms, setup 0ms, collect 376ms, tests 755ms, environment 0ms, prepare 72ms)

```

## Surface

`bun install --frozen-lockfile --ignore-scripts` exited 0 after regenerating the
lockfile for ai-hist. `bun run build` exited 0. Bun was invoked from
`/Users/khaliqgant/.bun/bin` because it was absent from the default PATH.

Command (packages/surface):

```sh
PATH=/Users/khaliqgant/.bun/bin:$PATH bun run test
```

Exit 0, captured output:

```text
$ bun run build && tsc -p tsconfig.test.json && vitest run
$ tsc

 RUN  v2.1.9 /Users/khaliqgant/flows-spec-F-memory/packages/surface

 ✓ tests/flow.test.ts (7 tests) 3ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  13:37:14
   Duration  253ms (transform 21ms, setup 0ms, collect 21ms, tests 3ms, environment 0ms, prepare 32ms)

```

## SDK

Dependency installation and compile commands (packages/sdk), exit 0:

```sh
npm ci --ignore-scripts
npm install ../surface --no-save --ignore-scripts
npm run typecheck
npm run build
npm run typecheck:tests
```

Captured compiler output:

```text
> @relayflows/sdk@2.0.8 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json

> @relayflows/sdk@2.0.8 build
> tsc && node scripts/make-cli-executable.mjs

> @relayflows/sdk@2.0.8 typecheck:tests
> tsc -p tsconfig.tests.json
```

Full suite command (packages/sdk):

```sh
RELAYFLOWD_BIN=/Users/khaliqgant/flows-spec-F-memory/kernel/target/debug/relayflowd ./node_modules/.bin/vitest run
```

Exit 1. The remaining failure is the real Claude analyzer auth probe;
no analyzer-skip override was used. Captured final failure and totals:

```text
 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
Error: LIVE_ANALYZER_UNAVAILABLE: "/Users/khaliqgant/flows-spec-F-memory/testdata/preflight/analyze-story-claude-cli auth status" exited 1: analyze-story-claude-cli: "claude -p --model claude-haiku-4-5-20251001" exited 1: — failing because gate-2 acceptance requires the real analyzer to execute. Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.
 ❯ tests/live-kernel.test.ts:1186:15
    1184|       const notice = `LIVE_ANALYZER_UNAVAILABLE: ${readiness.detail}`;
    1185|       if (process.env['RELAYFLOWS_ALLOW_ANALYZER_SKIP'] !== '1') {
    1186|         throw new Error(
       |               ^
    1187|           `${notice} — failing because gate-2 acceptance requires the …
    1188|           + 'Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 51 passed | 1 skipped (53)
      Tests  1 failed | 972 passed | 3 skipped (976)
   Start at  13:37:28
   Duration  51.28s (transform 735ms, setup 0ms, collect 3.73s, tests 168.41s, environment 4ms, prepare 1.53s)

```

## Kernel

Command (kernel):

```sh
/Users/khaliqgant/.cargo/bin/cargo test --workspace
```

Exit 0. Cargo was absent from default PATH; the installed rustup shim was used.
Captured final output excerpt:

```text
test subscriptions::tests::sweep_marks_row_stale_when_silence_exceeds_budget ... ok
test subscriptions::tests::sweep_ignores_subscriptions_whose_silence_is_still_within_budget ... ok
test subscriptions::tests::sweep_election_gives_the_first_caller_the_result_and_second_gets_empty ... ok
test channel::tests::channels_cross_segment_boundaries_and_terminal_runs_reject_mutations ... ok
test subscriptions::tests::upsert_is_idempotent_across_bumps_and_preserves_event_type_updates ... ok
test subscriptions::tests::upsert_after_stale_re_arms_and_next_silence_can_re_emit ... ok
test tests::an_unconfirmed_election_is_reclaimed_by_the_next_attempt_not_treated_as_done ... ok
test tests::failed_commit_is_returned_not_swallowed ... ok
test channel::tests::failed_channel_writes_never_expose_delivery_or_advance_acknowledged_offset ... ok
test tests::append_is_durable_and_monotonic_after_reopen ... ok
test tests::terminal_run_refuses_every_later_entry_atomically ... ok
test tests::rollover_is_atomic_scaffolding_for_epoch_resume ... ok
test tests::effects_are_deduplicated_at_the_journal_boundary ... ok
test channel::tests::independent_connections_serialize_send_receive_and_acknowledgement ... ok

test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s

   Doc-tests relayflowd

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests relayflowd_core

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests relayflowd_journal

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```
