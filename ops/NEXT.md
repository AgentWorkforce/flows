# NEXT — gate 2: split wake-context resolution failure by cause (the rest of D1)

**Scope.** The next gate is **gate 2**, by Khaliq's decision on 2026-09-16.
Not gate 3. If you are reading a target that says gate 3, it is stale — the
launcher used to synthesise "gate 3" over a gate-2 brief, which is the
contradiction that wedged the loop for four days.

## Objective

Close the remainder of **deviation D1** in
`docs/RFC-0001-everything-is-a-relayflow.md`. That document names it a
binding obligation, in these words:

```
gate 2 cannot go green until D1 and D2 are closed
```

D1 is half done. PR #252 stopped the resume path swallowing a journal scan
error into `wake_context: None`, so the error now propagates out of
`resolve_wake_context` in `kernel/relayflowd/src/engine/drive.rs`. That
function's own doc comment says what is still missing, in its own words:

> That is deliberately narrower than the eventual contract. The intended
> end state classifies the failure and journals it (transient → retry the
> attempt under its budget; permanent → park `needs_human`), and none of
> that classification exists yet.

The classification still does not exist. `wake_context_unresolved` — the
journal entry RFC rule 10a requires, and the entry rule 11c makes the gate
assert on — appears nowhere in the kernel. Today an unreadable segment
aborts the dispatch before any attempt is recorded, and recovery only
arrives when the lease expires and a later drive abandons the attempt as
`Crashed`. Nothing in the journal says the wake context was the reason.

## What RFC rule 10a requires

Resolution failure splits by cause, because transient I/O and permanent
corruption deserve opposite handling:

- **Transient** (segment unreadable right now: I/O error, lock contention, a
  truncated tail still being written) — fail the attempt, **retryable**,
  under the step's ordinary retry budget. Journal `wake_context_unresolved`
  with `reason: "transient"` and the underlying error.
- **Permanent** (the run is open on a wake, the current segment reads
  cleanly, and no wake context is present) — fail the step and park as
  **`needs_human`**, not retryable. Journal `wake_context_unresolved` with
  `reason: "absent"`.

Neither case may fall back to `wake_context: None`. Dispatching with no
context is reserved for runs that were never woken.

## Files in scope

- `kernel/relayflowd-core/src/entry.rs` — add the `WakeContextUnresolved`
  entry type and its `wake_context_unresolved` wire string, beside the
  existing `SubscriptionMatched` / `subscription.matched` pair.
- `kernel/relayflowd/src/engine/drive.rs` — classify the failure at the
  `resolve_wake_context` call site and journal it, instead of aborting the
  dispatch before anything is recorded. Update the doc comment: it currently
  describes the classification as absent, and that must stop being true.
- A new kernel integration test under kernel/relayflowd/tests/ asserting on
  the two journal shapes rule 11c names. Model it on
  `kernel/relayflowd/tests/event_wake.rs`, which already builds a woken run
  and reads `SubscriptionMatched` back out of the journal.

**The permanent case is reachable today.** A run that was woken, whose
`subscription.matched` entry carries no `wake_context` key, currently
resolves to `Ok(None)` and is indistinguishable from never-woken. That is
the shape to detect: open on a wake, clean read, no context.

## Definition of done

1. `wake_context_unresolved` exists as a typed journal entry with a `reason`
   of `transient` or `absent`, and the kernel writes it at the classification
   site — not only in a test.
2. A transient failure fails the attempt and stays retryable under the step's
   ordinary budget. A permanent failure parks the run as `needs_human` and is
   not retried.
3. A new test asserts on the two journal shapes from RFC rule 11c: *never
   woken* is the ABSENCE of any `wake_context_unresolved` entry alongside a
   dispatch with no wake context; *failed to resolve* is the PRESENCE of that
   entry naming its reason, with no dispatch for that attempt. Assert on
   journal entries, not on log text.
4. Every new test must be confirmed to FAIL against current code before the
   fix — revert the source change, watch it fail, and paste the literal
   failing output into your summary. A test that has never been observed
   failing pins nothing.
5. `cargo test --workspace` must be green, run from the kernel directory:
   ```
   cd kernel && sh ../ops/cargo.sh test --workspace
   ```
6. As your last action, run `git status --porcelain` and paste it.

## Explicitly OUT of scope

- **D2 and epoch rollover.** The RFC sequences this as engine-side epoch
  rollover → D2 → gate 2 and states that D2 is not implementable in
  isolation: every construction of `EpochSummaryPayload` in the kernel is
  inside a test, so there is no site at which to add the carry-forward.
  Adding the field first would be "the appearance of a fix, not one". Do not
  start it here.
- **Trigger-plane liveness.** Already shipped in PR #122 —
  `kernel/relayflowd/src/server/liveness.rs` with
  `kernel/relayflowd/tests/subscription_liveness.rs`. Do not rebuild it.
- **The hn-monitor runner.** Already shipped in PR #120 —
  `packages/sdk/src/cli/hn-monitor.ts`. Three separate escalations have now
  proposed rebuilding it. Do not.
- **Flipping the gate-2 verdict.** That is Khaliq's read, not a run's. See
  `ops/STATE.md`.
- **The analyze-agent clause.** Whether it is gate-2 or gate-4 scope is an
  open question for Khaliq, recorded in `ops/STATE.md`.
- `.github/workflows/*`, `packages/sdk/*`, and `ops/*` other than this file.
