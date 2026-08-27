# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-f59e279-08271341`, HEAD = `f59e279`, identical to `origin/main`).

## Assessment snapshot (evidence)

- **Standing directives checked first** (`ops/DIRECTIVES.md`): **no active
  directives** — the file carries only its header; directive 1 (de-vendor
  kernel deps) was satisfied and removed by PR #3. Nothing outranks gate work
  this tick.
- **Open PRs: none.** `gh pr list --state open` → empty. PRs #1–#4 are all
  MERGED (#4 merged 2026-08-27T17:04Z as `f59e279`). **Nothing is awaiting
  review fixes**, so new gate work is permitted (the "no new work over
  unfinished work" rule does not bind this tick).
  - PR #4 drew five findings from the Codex reviewer (3× P1 concurrency /
    lease, 1× P1 error-swallowing, 1× P2 watch gap). All five were fixed
    before merge, each pinned by a mutation-verified test; the evidence is
    persisted at `ops/reviews/20260827-1334-pr4-fixes.md`. No follow-up is
    outstanding from that review.
- **Tests on `main` at assessment time** (this machine, hermetic
  `ops/cargo.sh`, no manually exported env vars):
  - `cd kernel && ../ops/cargo.sh test --workspace` → **47 passed, 0 failed**
    (8 + 13 + 19 + 2 + 5 across relayflowd lib, crash_resume, core lib,
    spec_parity, journal lib), exit 0.
  - `cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings` → exit 0.
  - `cd kernel && ../ops/cargo.sh fmt --check` → exit 0, no output.
  - `cd sdk && npm test` → **54 passed, 0 failed** (5 files), exit 0.
- **Current gate: gate 1** (RFC-0001 §3). Its done-when does **not** hold:
  - Rung (a) — pure deterministic flow, exhaustive SIGKILL sweep, budget
    exactness — **closed on `main`** (PR #2, `74a3639`).
  - Rung (b) — the same flow plus a bare `llm` step with a verification gate,
    out-of-band worker, memoized output — **closed on `main`** (PR #4,
    `f59e279`); all twelve protocol v0 verbs are implemented in
    `kernel/relayflowd/src/server.rs`.
  - Rung (c) — the same flow plus an `agent` step with Appendix A pins —
    **does not exist.** `ensure_supported`
    (`kernel/relayflowd/src/engine.rs:462`, called at `:101` and `:164`)
    honestly fails closed on any `agent` step. Spec/SDK modelling is already
    in place and unexercised: `StepKind::Agent`
    (`kernel/relayflowd-core/src/spec.rs:208`), `AgentSurfaces`, `RecoveryMode`
    (`:239`), `PermissionsSpec`, journal `Pins` / `WorkspacePin` / `StreamPin`
    (`kernel/relayflowd-core/src/entry.rs:133`), `end_pins` + `effects` on
    `StepCompletedPayload` (`:176`), `EffectRecordedPayload` (`:286`), and the
    journal-boundary effect dedupe table with a unique
    `(step_id, idempotency_key, surface_path)` winner
    (`kernel/relayflowd-journal/src/append.rs:46`, test
    `effects_are_deduplicated_at_the_journal_boundary`,
    `kernel/relayflowd-journal/src/lib.rs:312`). `recovery_mode` is journaled
    at attempt start (`machine.rs:120`) and **acted on nowhere** — recovery
    (`recovery_actions_filtered`, `machine.rs:265`) ignores it. Nothing ever
    appends an `effect.recorded` entry outside the journal crate's own test.
  - The second done-when clause — **`flows check` preflight (covenant 2)** —
    also does not exist (no `check`/preflight symbol anywhere in `sdk/src`,
    no CLI binary in `sdk/package.json`). That is the package *after* this
    one; the ladder rung comes first because the preflight must be able to
    refuse a rung-(c) flow, which requires rung (c) to be real.
- **Backlog** (`ops/BACKLOG.md`): release pipeline, schedule re-registration,
  PR-shepherd flow, harness design-partner asks — all gate-2+ or below gate-1
  needs; none block rung (c). Two previously-flagged process gaps are now
  fixed at the workflow level (`workflows/drive.yaml`: the review step writes
  `ops/reviews/…-review.md`, the pr step names the WP) — this tick should
  confirm they actually fire rather than re-plan them.

## Work package: WP-3 — `agent` step + Appendix A (gate-1 ladder rung (c))

### Objective

Make ladder rung (c) real: the hello flow plus an `agent` step runs end to end
on the real `relayflowd` binary, dispatched to an out-of-band worker, with RFC
Appendix A honored as *mechanism* — pins on start, effects as deduped journaled
facts, recovery modes that actually change what the next attempt sees, and
completion pinning the end state that defines the next step's start. It
survives `kill -9` at every boundary and mid-attempt, resumes completing only
unfinished work, and its budget accounting stays exact.

Concretely:

1. **Dispatch.** Retire `ensure_supported`'s blanket agent refusal
   (`engine.rs:462`) in favor of real `agent` dispatch over the existing
   out-of-band worker path (`worker.attach` → `step.dispatch` →
   `step.heartbeat` → `step.complete`). An `agent` step with no compatible
   worker attached parks as `waiting_worker` exactly like `llm` — never
   silently succeeds.
2. **Pin on start (rule 2).** `step.attempt.started` for an agent step carries
   the declared surfaces' pins: a `revision_id` per declared workspace surface
   and a `read_offset` per declared stream, alongside the attempt's stable
   idempotency key (`sha256(run_id ‖ step_id)`, stable across attempts per
   DESIGN.md §1.2) and the step's `recovery_mode`. Revision ids stay **opaque
   strings supplied by the worker** — mounts are a gate-6 concern (DESIGN.md
   §5 "Not in v0"); the kernel journals, chains and enforces them, and never
   computes one.
3. **Effects are journaled facts, deduped at the boundary (rules 3 and 5).**
   A worker records a writeback *before* performing it and learns whether it is
   a duplicate: an `effect.recorded` append returning `{deduped}` from the
   existing dedupe table, so a second attempt's provider call is suppressed
   rather than merely detected afterwards. This needs a worker-facing path
   (an `effect.record` verb is the straightforward shape); if a verb is added,
   `kernel/DESIGN.md` §5's verb table is updated in the same PR — the doc and
   the protocol never diverge. `step.complete` carries the attempt's
   `EffectRef` list (today `server.rs:238` hardcodes `Vec::new()`).
4. **Recovery modes are honored or refused (rule 4).** A declared mode that is
   silently downgraded is a fail-open, so each of `reset` / `inspect` /
   `manual` must either be implemented or **refused at `run.start`** with a
   declared error. `reset` must be implemented in full: after a dead attempt,
   the next attempt is dispatched with the pinned revision to restore to, and
   the kernel fails the attempt closed (`worker_error`) if the worker reports
   starting from anything other than the pinned revision. `inspect` starts the
   next attempt in the dirty workspace with the failed attempt's
   `completionReason` and trajectory tail injected into the dispatch;
   `manual` parks the step as `needs_human` via `wait.human` carrying a
   diff reference, and never re-dispatches.
5. **Completion pins the end state (rule 6).** `step.completed` records
   `end_pins`; the next agent step's `step.attempt.started` pins *are* those
   end pins — a broken chain (a step starting from a revision no completion
   produced) is a hard error, not a warning.
6. **Crash-injection gate for agent steps (rule 7).** Extend the
   `kernel/relayflowd/tests/crash_resume` sweep to a rung-(c) fixture: kill
   before the first step, between every step pair, mid-agent-attempt with a
   worker holding a lease, after the final effect, and under `serve`; resume
   through the real `relayflowd resume` CLI. Under `reset`, kill mid-edit and
   assert (a) the second attempt observed the pinned revision, (b) the
   provider observed exactly one effect, (c) the journal explains both
   attempts with declared `completionReason`s.

The agent worker in the test gate is a **deterministic in-test stub** speaking
the real protocol over the real socket (the rung-(b) `llm_support.rs` stub is
the pattern). No live CLI agent, no network, no model call: what is being
proven is kernel semantics — pins, dedupe, recovery, memoization, budget.

### Files in scope

- `kernel/relayflowd/src/engine.rs` — retire the agent refusal; agent dispatch
  paths. **The file is 498 lines and AGENTS.md rule 1 caps design smell at
  ~500** — split the drive loop out as part of this package rather than
  growing it.
- `kernel/relayflowd/src/engine/remote.rs`, `src/worker.rs`,
  `src/server.rs`, `src/server/{session,wire,reconcile}.rs` — agent dispatch
  payload (pins, recovery instruction, trajectory tail), effect recording
  path, `step.complete` carrying `effects`/`end_pins`.
- `kernel/relayflowd-core/src/{machine,state,entry,spec}.rs` — recovery-mode
  branching in recovery/next-attempt actions, end-pin chaining, park-on-manual;
  only what rung (c) needs (no speculative abstraction, AGENTS.md rule 6).
- `kernel/relayflowd-journal/src/{append,lib}.rs` — only if effect recording
  needs a surface beyond the existing dedupe table (prefer the existing one).
- `kernel/relayflowd/tests/crash_resume/` — rung-(c) sweep + agent stub-worker
  support module.
- `testdata/hello-agent.flow.yaml` + canonical spec + `.sha256`, pinned on
  both sides; parity tests extended
  (`kernel/relayflowd-core/tests/spec_parity.rs`,
  `sdk/tests/spec-parity.test.ts`).
- `sdk/src/` — only if the effect path adds a verb the client must speak
  (`journal-client.ts`, `protocol.ts`) plus its test coverage.
- `kernel/DESIGN.md` — §5 verb table and §1.9/§3 agent-step prose kept true to
  what ships. **Not** the RFC, **not** the charter.

### Definition of done

All of the following pass on the flow branch with no manually exported env
vars; paste the verbatim tails into the PR body:

```sh
(cd kernel && ../ops/cargo.sh test --workspace)              # green, incl. the rung-(c) sweep
(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)
(cd kernel && ../ops/cargo.sh fmt --check)
(cd sdk && npm test)
```

Counts must not shrink: kernel **≥ 47** passing (today's baseline) plus the new
rung-(c) tests, sdk **≥ 54** passing. Additionally, each of these holds, pinned
by a test named for what it proves:

- SIGKILL at every boundary of the rung-(c) flow (before the first step,
  between every pair, mid-agent-attempt with a worker attached, after the final
  effect, and under `serve`) → resume via the real `relayflowd resume` CLI
  completes only unfinished work; completed steps replay as results.
- Appendix A rule 7 under `reset`: kill mid-edit → the second attempt's
  dispatch carries the pinned revision, the stub provider's effect counter
  reads exactly 1, and both attempts appear in the journal with declared
  `completionReason`s.
- An attempt that reports starting from a revision other than its pin under
  `reset` fails closed with a declared failure kind (never a raw error).
- `inspect` starts the retry in the dirty workspace with the prior attempt's
  tail present in the dispatch; `manual` parks `needs_human` and does not
  re-dispatch — or, for any mode not implemented, `run.start` refuses the spec
  with a declared error (a silently downgraded mode is a defect).
- Effect dedupe end-to-end: two attempts writing the same
  `(step_id, idempotency_key, surface_path)` produce one provider call and a
  second `effect.recorded` with `deduped: true`.
- End-pin chaining: a step's start pins equal the previous completion's
  `end_pins`; a broken chain is a hard error with a test.
- Journal-derived budget assertion extended to rung (c): the resumed run's
  token spend equals one execution of each step.
- Failure taxonomy stays closed: every failed rung-(c) run's journal
  terminates in a declared failure kind.
- No file in `kernel/` exceeds 500 lines after the change
  (`find kernel -name '*.rs' -not -path '*/target/*' | xargs wc -l`).

### Out of scope for this tick

- **`flows check` preflight (covenant 2)** — gate 1's other done-when clause;
  it is the next package, not this one.
- **Real mounts / relayfile** (gate 6). Revision ids stay opaque strings from
  the worker, per DESIGN.md §5.
- **Permission enforcement** (`PermissionsSpec`, `access_preset`) — gate 8;
  carried as data only, as today.
- **Live agent CLI or model calls** anywhere in the test gate; a real-provider
  run is follow-up evidence work.
- **Durable-channel semantics beyond stream pins** (consumer-offset
  management as a verb), gates 2–9, the release pipeline, and every other
  `ops/BACKLOG.md` item.
- **RFC or charter edits**, and any history rewrite of the PR #2-era vendored
  blobs (a human decision).

### Delivery

One PR against `main` from a `flow/` branch. Every commit message names WP-3;
the PR title states the work; the PR body carries the four verify tails
verbatim plus the Appendix A assertions above. The review step must leave its
transcript in `ops/reviews/` (this is the first tick where that wiring is
expected to fire — if it does not produce a file, say so in DRIVE-LOG rather
than inferring a verdict from gating). The Lead does not merge: report and
await human review, per the charter's hard rails.

ASSESS_DONE
