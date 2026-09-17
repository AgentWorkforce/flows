# Event Await — Kernel and local daemon slice

Implementation commit: `5742029e02ac66d306cc19d1267fe92f2e6ba6c4`
(`feat(kernel): add durable event activities`).

## Scope and transport boundary

The Rust cell now journals body-level `subscription.opened`, durable
`wait.event` cursor waits, `stream.appended` delivery-id frames,
`subscription.overflow.fenced`, and `subscription.closed`. It exposes the
Surface slice's `subscription.open`, `subscription.next`, and
`subscription.close` protocol verbs. A `next` wait records absolute idle and
deadline instants, and recovery reclaims passed activity timers before normal
step recovery.

Cloud owns provider tenancy, immutable installation/resource authorization,
ingress replay, self-actor filtering, and the external binding fence. Its
transport boundary is:

1. Cloud durably records `(run_id, subscription_id, generation,
   ingress_offset)` and only then invokes local `subscription.open`.
2. For each authorized provider frame, Cloud calls the cell-local append path
   with the provider delivery id and encoded `EventFrameV1`; the kernel stores
   it as `stream.appended` and refuses duplicates or frames after closure.
3. On a would-exceed frame Cloud fences its binding, then submits the local
   overflow close. The local daemon mirrors that fence durably and recovery
   completes the close without reopening the cursor.

No tenant id, provider SDK, installation lookup, or authorization policy was
added to the kernel.

## Focused coverage

`kernel/relayflowd/tests/event_activities.rs` uses the real SQLite journal:

- append while work is elsewhere, delivery-id dedupe, and restart after
  `stream.appended` before `next()`;
- durable idle wake;
- exact deadline/append tie, including pending unread range;
- 1,000 unread-frame boundary, fence-before-close recovery, and refusal after
  fencing;
- terminal cancellation closes an activity before `run.completed`.

## Commands and captured output

Command (exit 0):

```text
cd /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917/kernel
/Users/khaliqgant/.cargo/bin/cargo check --workspace

    Checking relayflowd v0.1.0 (.../kernel/relayflowd)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.82s
```

Command (exit 0):

```text
cd /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917/kernel
/Users/khaliqgant/.cargo/bin/cargo test -p relayflowd --test event_activities --no-fail-fast

running 5 tests
test exact_deadline_tie_wins_and_reports_unread_range ... ok
test cancel_closes_an_open_activity_before_the_terminal_run_record ... ok
test accepted_append_is_buffered_deduplicated_and_survives_a_restart_before_next ... ok
test idle_wait_is_durable_and_fires_without_an_event ... ok
test overflow_closes_before_the_1001st_unread_frame_and_recovery_never_reopens_it ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.81s
```

Command (exit 1; repository-wide formatting baseline, not modified):

```text
cd /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917/kernel
/Users/khaliqgant/.cargo/bin/cargo fmt --check

Diff in .../kernel/relayflowd/src/engine/remote.rs:588:
Diff in .../kernel/relayflowd/tests/event_wake.rs:191:
Diff in .../kernel/relayflowd/tests/hn_monitor_integration.rs:36:
Diff in .../kernel/relayflowd-core/src/machine/tests.rs:63:
...
```

The formatter reports pre-existing changes outside this slice; it was not run
in write mode, preserving unrelated work.
