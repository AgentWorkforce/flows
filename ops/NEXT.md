# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-0ba6c88-08271225`, HEAD = `0ba6c88`, identical to `main`).

## Assessment snapshot (evidence)

- **Standing directives checked first** (`ops/DIRECTIVES.md`): **no active
  directives.** Directive 1 (de-vendor kernel deps) was satisfied and removed
  by PR #3, merged as `0ba6c88`. Nothing outranks the gate work this tick.
- **Open PRs: none** (`gh pr list --state open` → `[]`). PR #2 merged as
  `74a3639`, PR #3 merged as `0ba6c88`. Nothing is awaiting review fixes, so
  new gate work is permitted.
- **Current gate: gate 1** (RFC-0001 §3). Its done-when does not hold:
  - Rung (a) — pure deterministic flow, exhaustive SIGKILL sweep, budget
    exactness — **closed on `main`** (PR #2).
  - Rung (b) — the same flow plus a bare `llm` step with a verification
    gate — **does not exist**. `ensure_deterministic`
    (`kernel/relayflowd/src/engine.rs:307`, called at engine entry points
    :75 and :124) refuses any non-deterministic step, honestly fail-closed.
    `serve` implements 5 of protocol v0's 12 verbs; `worker.attach`,
    `step.heartbeat`, `step.complete`, `run.watch`, `stream.append`,
    `stream.read`, `event.emit` are types-only (present in `sdk/src/protocol.ts`,
    absent from `kernel/relayflowd/src/server.rs` — grep confirms zero hits).
  - Rung (c) — `agent` step + Appendix A pins — parse-only.
- **Tests at assessment time (2026-08-27, this machine, hermetic wrapper,
  no manually exported env vars):**
  - `kernel/`: `../ops/cargo.sh test --workspace` → **33 passed, 0 failed**
    (suites 5+3+19+1+5), exit 0.
  - `sdk/`: `npm test` → **50 passed, 0 failed** (5 files), exit 0.
- **Backlog** (`ops/BACKLOG.md`): release pipeline, review-transcript
  persistence, schedule hygiene — all remain below gate-1 needs; none block
  rung (b). The review-transcript gap has now been flagged in two consecutive
  DRIVE-LOG entries; it stays out of this package but should be the first
  candidate whenever a tick has slack.

## Work package: WP-2 — `llm` step end to end (gate-1 ladder rung (b))

### Objective

Make ladder rung (b) real: the hello flow plus a bare `llm` step with a
verification gate runs end to end on the real `relayflowd` binary, driven by
an out-of-band worker over protocol v0 — and survives `kill -9` at every
step boundary and between them, resuming with the llm output memoized
(replayed, never re-generated) and exact budget accounting.

Concretely:

1. **Protocol verbs in `serve`:** implement `worker.attach`,
   `step.heartbeat`, `step.complete` (out-of-band completion),
   `run.watch`, `stream.append`, `stream.read`, `event.emit` in
   `kernel/relayflowd/src/server.rs`, journaled with the same
   fail-closed, `completionReason`-carrying discipline as in-process
   steps. Unknown verbs and malformed frames stay hard errors.
2. **Out-of-band worker path:** an `llm` step is leased to an attached
   worker (lease + heartbeat, `relayflowd-core` lease machinery already
   exists), completed via `step.complete`, and a dead worker's attempt is
   recorded dead (`completionReason` explained) and re-leased on resume.
3. **Verification gates drive semantic retry:** a failing gate on the llm
   output schedules a durable retry (`maxIterations`, deterministic
   backoff) — as control flow, not advice, reusing the core retry/verify
   machinery.
4. **Memoized llm output on resume:** after `kill -9`, resume through the
   real `relayflowd resume` CLI replays the completed llm step's journaled
   output; the worker is never re-asked. Budget: resumed run's token spend
   equals one execution of each step (extend PR #2's journal-derived
   budget-exactness assertion to rung (b)).
5. **Crash harness extended to rung (b):** extend the
   `kernel/relayflowd/tests/crash_resume` sweep — kill before/between/after
   every step, mid-llm-attempt (worker holding a lease), and
   kill-under-`serve` — for a testdata rung-(b) flow. The test worker is a
   deterministic stub speaking the real protocol over the real socket (no
   live model calls in the gate; live-model runs are eval work, not this
   test suite).

For the test suite the "llm" worker must be a deterministic in-test stub —
what is being proven is kernel semantics (lease, journal, memoization,
budget), which must not depend on network or a live model.

### Files in scope

- `kernel/relayflowd/src/server.rs` — the seven missing verbs.
- `kernel/relayflowd/src/engine.rs` — retire `ensure_deterministic`'s
  blanket refusal in favor of real `llm` dispatch (keep refusing `agent`
  steps fail-closed; that is rung (c)).
- `kernel/relayflowd/src/` — new module(s) for worker/lease session state
  as needed (follow the existing small-file layout; largest file today is
  ~400 lines).
- `kernel/relayflowd-core/src/` (`machine*`, `state*`, `retry.rs`,
  `verify.rs`, `entry.rs`) — only as needed to route out-of-band
  completion and llm verification through existing state-machine paths.
- `kernel/relayflowd-journal/src/` — only if a new entry shape requires it
  (prefer existing entry types; the 12 journal entry types were designed
  for this).
- `kernel/relayflowd/tests/crash_resume/` (+ `crash_resume.rs`) — rung-(b)
  sweep, stub worker helper.
- `sdk/src/journal-client.ts`, `sdk/src/protocol.ts` — client
  implementations for the new verbs (types exist; wire the methods) +
  `sdk/tests/journal-client.test.ts` coverage against a scripted server.
- `testdata/` — rung-(b) fixture flow (`hello` + `llm` step with a
  verification gate), canonical spec + hash pinned on both sides, parity
  tests extended (`sdk/tests/spec-parity.test.ts`,
  `kernel/relayflowd-core/tests/spec_parity.rs`).

### Definition of done

All of the following pass on the flow branch with no manually exported env
vars; paste verbatim tails in the PR body:

```sh
(cd kernel && ../ops/cargo.sh test --workspace)            # all green, incl. new rung-(b) crash sweep
(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)
(cd kernel && ../ops/cargo.sh fmt --check)
(cd sdk && npm test)                                       # all green, count >= 50, new verb tests included
```

And the rung-(b) semantics hold, each pinned by a test named for what it
proves:

- SIGKILL at every boundary of the rung-(b) flow (before first step,
  between every pair, mid-llm-attempt with a worker attached, after final
  effect, and under `serve`) → resume via the real `relayflowd resume` CLI
  completes only unfinished work; the llm step's output is replayed from
  the journal, the stub worker's completion counter shows exactly one
  generation per step.
- A failing verification gate on llm output schedules a durable retry and
  succeeds within `maxIterations`; exhaustion terminates in a declared
  failure kind, never a raw error.
- A worker killed while holding a lease → attempt recorded dead with an
  explained `completionReason`, step re-leased on resume, exactly-once
  effects.
- Journal-derived budget assertion: resumed rung-(b) run's token spend
  equals one execution of each step.
- Test counts do not shrink: kernel ≥ 33 and sdk ≥ 50 all passing, plus
  the new tests.

### Out of scope for this tick

- **Rung (c)** — `agent` step execution, Appendix A pin semantics, surface
  declaration, `reset`/`inspect`/`manual` recovery, mount-boundary dedupe.
  `agent` steps keep failing closed at dispatch.
- **Durable channels** (consumer offsets / at-least-once inter-agent
  messaging) beyond what `stream.append`/`stream.read`/`event.emit` verb
  plumbing itself requires. Full channel semantics land with rung (c)
  coordination work.
- **Live model calls** anywhere in the test gates; a real-provider eval run
  is follow-up evidence work, not this package.
- **`flows check` preflight**, gates 2–9, release pipeline, backlog items
  (incl. review-transcript persistence), any RFC or charter edits.
- **History rewrite** for the PR #2-era vendored blobs (human decision).

### Delivery

One PR against `main` from a `flow/` branch — and fix the process drift
called out in DRIVE-LOG for PR #3: every commit message names WP-2, the PR
title states the work (not the branch name), the PR body carries the
definition-of-done evidence verbatim, and no out-of-scope docs commits ride
along. The Lead does not merge; report and await human review (per charter
hard rails).

ASSESS_DONE
