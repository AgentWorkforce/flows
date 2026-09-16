Close the rest of RFC-0001 deviation D1: classify a wake-context resolution failure by cause and journal it. GATE 2. CODE task, `kernel/`-side (Rust).

**Retargeted 2026-09-16.** This brief previously asked for a new hn-monitor runner module in the SDK, as a gate-2 scaffolding PR. PR #120 shipped that work on 2026-09-01 as `packages/sdk/src/cli/hn-monitor.ts`. The brief outlived its work package by two weeks, and because `ops/autodrive.sh` also launched it under a hardcoded "gate 3", every assessor that read both correctly reported a contradiction and escalated instead of building. Seven consecutive runs (#417, #420, #422, #424, #426, #427, #428) produced nothing but escalation notes. **Do not rebuild the hn-monitor runner. It exists.**

**Context:** RFC-0001 states that gate 2 stays RED until deviations D1 and D2 are both closed. D2 is blocked upstream on engine-side epoch rollover — the RFC sequences it rollover → D2 → gate 2 and says D2 is not implementable in isolation, because every construction of `EpochSummaryPayload` in the kernel is inside a test. That leaves D1 as the actionable half, and it is already half done: PR #252 stopped `resolve_wake_context` in `kernel/relayflowd/src/engine/drive.rs` swallowing a journal scan error into `wake_context: None`. What remains is the classification that function's own doc comment says is missing — "transient → retry the attempt under its budget; permanent → park `needs_human`, and none of that classification exists yet".

**The task.** Implement RFC rule 10a:

  - a **transient** failure (I/O error, lock contention, a truncated tail still being written) fails the attempt and stays **retryable** under the step's ordinary retry budget, journalling `wake_context_unresolved` with `reason: "transient"` and the underlying error
  - a **permanent** failure (the run is open on a wake, the current segment reads cleanly, and no wake context is present) fails the step and parks as **`needs_human`**, not retryable, journalling `wake_context_unresolved` with `reason: "absent"`
  - neither may fall back to `wake_context: None` — dispatching with no context is reserved for runs that were never woken

`wake_context_unresolved` does not exist anywhere in the kernel today, so it needs a typed entry beside `SubscriptionMatched` in `kernel/relayflowd-core/src/entry.rs`.

**The gate is a journal shape, not a log line.** RFC rule 11c: *never woken* is the ABSENCE of any `wake_context_unresolved` entry alongside a dispatch carrying no wake context; *failed to resolve* is the PRESENCE of that entry naming its `reason`, with no dispatch for that attempt. Assert on those two shapes. `kernel/relayflowd/tests/event_wake.rs` already builds a woken run and reads entries back out of the journal — model the new test on it.

**Definition of done, all of it**

  - `wake_context_unresolved` is a typed journal entry carrying `reason`, written by the kernel at the classification site rather than only by a test
  - transient fails the attempt and retries under the ordinary budget; permanent parks `needs_human` and does not retry
  - a new kernel test asserts both journal shapes from rule 11c
  - the `resolve_wake_context` doc comment no longer describes the classification as absent — it currently does, at length, and a stale comment that contradicts the code is worse than none
  - EVERY new test confirmed to FAIL against current code (revert the source change; watch it fail), with the literal failing output pasted in your summary
  - `cd kernel && sh ../ops/cargo.sh test --workspace` must be green, with the output pasted
  - as your LAST action, run `git status --porcelain` and paste it

**Out of scope for THIS tick — DO NOT TOUCH**

  - D2, `EpochSummaryPayload`, and engine-side epoch rollover — blocked upstream, and the RFC says adding the field ahead of its producer is "the appearance of a fix, not one"
  - trigger-plane liveness — shipped in PR #122 (`kernel/relayflowd/src/server/liveness.rs`)
  - the hn-monitor runner or CLI — shipped in PR #120
  - flipping the gate-2 verdict in `ops/STATE.md` — Khaliq's read, never a run's
  - `.github/workflows/*` — no GHA changes
  - `packages/sdk/*` — this is a kernel task

**If you cannot finish.** Say so and file what you learned. A partial classification with an honest gap description beats a complete-looking one that cannot tell transient from permanent — conflating those two is the exact defect D1 exists to name.
