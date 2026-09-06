# Bootstrap report — gate-1 skeleton (flows-bootstrap-gate1)

Date: 2026-08-27. Produced by the `report` step of `workflows/bootstrap-gate1.yaml`.
Honest state only: what exists, what passed, what is missing.

## What was built

All of the following is **uncommitted** on `main` (untracked `kernel/`, `packages/sdk/`,
`testdata/`; `workflows/bootstrap-gate1.yaml` modified mid-run to swap the
adversary agent's CLI from `grok` to `claude`). A human decides branch/commit/PR.

### kernel/DESIGN.md (architect)
Gate-1 kernel design: 12 journal entry types with exact field lists
(`completionReason` on every completion; Appendix A pin fields — revision ids,
stream offsets, idempotency key), the SQLite journal schema (one file per run
cell, append-only, segment-per-epoch), the hello-ladder step state machine with
memoized resume, the three-crate cargo workspace layout, and journal protocol
v0 (12 verbs, JSON over unix socket).

### kernel/ — cargo workspace (kernel-dev)
- **relayflowd-core** — pure, no I/O, no wall clock: fail-closed spec parsing
  (`deny_unknown_fields` everywhere plus an explicit key-set check where
  `#[serde(flatten)]` defeats serde), the step state machine with memoized
  replay, verification gates as control flow, retry with deterministic
  backoff+jitter, leases, recovery, simulated clock, journal entry types.
- **relayflowd-journal** — append-only SQLite journal (WAL, `synchronous=FULL`),
  fail-closed writes (a failed commit is returned, not swallowed), effect
  deduplication at the journal boundary, rebuildable run registry, atomic
  segment-per-epoch rollover scaffolding.
- **relayflowd** (binary) — `run`, `resume`, and `serve` commands; executes
  deterministic-step run specs end to end and resumes interrupted runs
  re-executing only unfinished steps. `serve` speaks a subset of protocol v0
  (`hello`, `run.start`, `run.resume`, `run.get`, `journal.read`), versioned
  handshake, fail-closed on unknown verification keys.
- Largest file 397 lines; `cargo clippy -D warnings` and `cargo fmt --check`
  passed at build time (per kernel-dev's step report).

### packages/sdk/ — @relayflows/sdk, TypeScript (sdk-dev)
- `spec.ts` — spec types mirroring RFC §1's ladder (`deterministic | llm |
  agent`), verification gates, recovery modes, agent surfaces, budgets;
  zero-agent flows legal by construction.
- `canonical.ts` — canonical JSON + `specHash` (sha256, matches the kernel's
  `spec_hash`).
- `validate.ts` — fail-closed validation (22 rejection cases pinned in tests).
- `compile.ts` — YAML → spec JSON compiler with defaults materialized;
  `toKernelSpec` emits the single snake_case boundary dialect.
- `protocol.ts` / `journal-client.ts` — protocol v0 types for all 12 verbs and
  a newline-delimited-JSON unix-socket client with request correlation, event
  demux, and fail-closed error handling.

### testdata/ — shared parity fixture
`hello-ladder.flow.yaml` → `hello-ladder.spec.canonical.json` + sha256, pinned
bit-for-bit on **both** sides (`packages/sdk/tests/spec-parity.test.ts`,
`kernel/relayflowd-core/tests/spec_parity.rs`), so the SDK-compiled spec and
the kernel-parsed spec provably hash identically.

## Test results (verbatim)

Both suites re-run for this report on 2026-08-27. Environment caveat, honestly
noted: `~/.cargo/registry` is a broken symlink to an unmounted external volume
("Paris Drive"), which failed the workflow's own `kernel-tests` deterministic
step (`error: failed to create directory …/registry/cache/… File exists`). The
run below used a temporary `CARGO_HOME` as a workaround; nothing in `kernel/`
is at fault, but CI on this machine is broken until the symlink is fixed.

### `cargo test --workspace` — 30 passed, 0 failed

```
running 4 tests
test server::tests::hello_enforces_protocol_version ... ok
test server::tests::run_start_fails_closed_on_an_unknown_verification_key ... ok
test exec_det::tests::captures_deterministic_output ... ok
test exec_det::tests::timeout_has_an_explicit_completion_reason ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 3 tests
test an_attempt_left_running_is_recorded_dead_and_replaced_on_resume ... ok
test completed_steps_are_not_reexecuted_after_process_state_is_dropped ... ok
test sigkill_mid_run_preserves_completed_effects_and_replaces_the_dead_attempt ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.53s

running 17 tests
test clock::tests::simulated_clock_is_explicitly_advanced ... ok
test journal::tests::memory_journal_assigns_sequences_and_rolls_epochs ... ok
test retry::tests::jitter_is_repeatable_and_bounded ... ok
test spec::tests::a_misspelled_step_level_key_is_a_parse_error ... ok
test spec::tests::a_misspelled_verification_gate_key_is_a_parse_error_not_a_dropped_gate ... ok
test spec::tests::cycles_are_rejected ... ok
test spec::tests::spec_version_is_semver_and_gated ... ok
test machine::tests::machine_starts_runnable_step_with_stable_effect_key ... ok
test machine::tests::successful_memo_is_never_scheduled_again ... ok
test machine::tests::verification_failure_schedules_a_durable_retry ... ok
test spec::tests::zero_agent_flow_is_valid ... ok
test spec::tests::the_full_ladder_parses_in_the_one_dialect ... ok
test spec::tests::unknown_root_and_nested_fields_are_rejected ... ok
test state::tests::budget_decimal_strings_add_without_floats ... ok
test verify::tests::deterministic_output_requires_successful_exit_and_content ... ok
test state::tests::completed_output_is_memoized_and_unlocks_dependents ... ok
test verify::tests::json_schema_is_a_control_gate ... ok
test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 1 test
test the_kernel_parses_the_sdk_compiled_spec_and_stamps_the_same_hash ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 5 tests
test registry::tests::registry_is_a_rebuildable_run_locator ... ok
test tests::failed_commit_is_returned_not_swallowed ... ok
test tests::rollover_is_atomic_scaffolding_for_epoch_resume ... ok
test tests::effects_are_deduplicated_at_the_journal_boundary ... ok
test tests::append_is_durable_and_monotonic_after_reopen ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### `npm test` (packages/sdk/: `tsc --noEmit && vitest run`) — 41 passed, 0 failed

```
 ✓ tests/journal-client.test.ts (7 tests) 17ms
 ✓ tests/spec-parity.test.ts (2 tests) 9ms
 ✓ tests/validate.test.ts (22 tests) 12ms
 ✓ tests/hello-deterministic.test.ts (5 tests) 12ms
 ✓ tests/deterministic-llm.test.ts (5 tests) 12ms

 Test Files  5 passed (5)
      Tests  41 passed (41)
```

## Review verdict

**REVIEW_PASSED** — but only on the second pass. The first adversarial review
refuted the skeleton with demonstrated failures: fail-open verification (a
misspelled gate key silently dropped the gate), a false SDK↔kernel hash-parity
claim, a `task` vs `instruction` dialect split, crash tests that never sent
SIGKILL, a journal-client test overclaiming what it proved, and overloaded
epoch-resume fields. Two repair rounds fixed all six; the re-review verified
each fix empirically (source read, both suites run, three independent
end-to-end experiments against the real binary, including reading `spec_hash`
back out of the SQLite journal — byte-identical to the SDK's).

Minor observations carried forward from the review (not violations):
1. `JournalClient.runStart` types its param as the authoring `FlowSpec`, but
   the kernel parses the kernel dialect — fail-closed seam wart, one-line fix.
2. `next_actions` returns only `ArmTimer` for the first backing-off step in
   spec order — wall-clock inefficiency for future parallel DAGs, irrelevant
   to the sequential gate-1 ladder.
3. `packages/sdk/dist/` build artifacts are checked in; fresh today, but they can drift.

## What gate 1 still needs

Gate 1's done-when: the full hello ladder (a/b/c) survives `kill -9` **at
every step boundary and between them**, resumes completing only unfinished
work, replays results not code, with exact budget accounting.

1. **kill -9 harness against the real binary — partially exists, must be
   completed.** `crash_resume.rs` already SIGKILLs the real `relayflowd`
   process group mid-attempt and asserts exactly-once effects, an explained
   dead attempt (`crashed | lease_expired`), and no re-execution. Still
   missing: a systematic sweep of kill points (every boundary and mid-step,
   not one chosen point), resume driven through the real binary's `resume`
   CLI in the SIGKILL case (today that test resumes via in-process
   `Engine::new().resume()`; only the `--stop-after` test resumes via the
   binary), kill-under-`serve`, and the budget assertion (resumed run's token
   spend equals one execution of each step).
2. **llm step.** Parses on both sides; the binary refuses to execute it
   (`ensure_deterministic`, `kernel/relayflowd/src/engine.rs:231` — honest
   fail-closed, not silent). Needs dispatch, verification-gate-driven semantic
   retry, and the memoized value on resume. Depends on the missing protocol
   verbs: `serve` implements 5 of 12 (`worker.attach`, `step.heartbeat`,
   `step.complete` (out-of-band completion), `event.emit`, `stream.append`,
   `stream.read`, `run.watch` are types-only). Durable channels
   (journal-append messages with consumer offsets) are likewise not built.
3. **agent step + Appendix A pins.** Parse-only today. Needs: declared
   mutable surfaces; `step.attempt.started` pinning revision ids, stream
   offsets, and the idempotency key (entry fields exist — `StepOpenSummary`
   carries `idempotency_key`; the pinning semantics do not); `reset` /
   `inspect` / `manual` recovery; effect dedupe by
   `(step id, idempotency key, surface path)` at the mount boundary (journal-
   boundary dedupe exists as scaffolding); and Appendix A rule 7's
   crash-injection extension — kill mid-edit, assert pinned-revision restart
   and exactly one provider effect.

## Next three work packages (priority order)

1. **WP-1: Close ladder rung (a) — exhaustive crash harness + budget
   exactness.** Kill-point sweep against the real binary (every boundary,
   mid-step, and under `serve`), resume via the binary CLI in all cases,
   budget assertion, and fix the broken `~/.cargo/registry` symlink or pin a
   repo-local `CARGO_HOME` so the workflow's own `kernel-tests` gate runs
   green. Fold in the review's three minor observations (runStart type,
   `ArmTimer` scheduling, drift-prone `dist/`). Rung (a) is then done per the
   RFC, not just demonstrated once.
2. **WP-2: llm step end to end — ladder rung (b).** Implement the remaining
   protocol verbs (`worker.attach`, `step.heartbeat`, `step.complete`,
   `run.watch`, `stream.*`, `event.emit`) in `serve`, an out-of-band worker
   path with lease + heartbeat, verification gates driving semantic retry
   (`maxIterations`, backoff), memoized llm output on resume, and extend the
   crash harness to rung (b).
3. **WP-3: agent step + Appendix A — ladder rung (c).** Surface declaration,
   pin-on-start (revision ids / worktree base commit, stream offsets,
   idempotency key), `reset` recovery first (then `inspect`/`manual`), effect
   dedupe at the mount boundary, completion pinning end state, and the rule-7
   crash-injection gate for agent steps. Gate 1 is then green in full.

REPORT_DONE
