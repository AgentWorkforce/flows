# Awaiting events inside a run

*Companion to RFC-0001 (settled decision 13) and `docs/SURFACE.md`. Status:
proposed, 2026-09-17. Governs the resident verb `on` when it is used inside a
running flow body rather than as the flow's entry condition.*

## 1. The problem

A flow that opens a pull request is not finished when the PR exists. CI fails,
reviewers comment, the base branch moves. The work is "babysit this PR until
it is merged, closed, or handed to a human" — and nobody can know in advance
when the last piece of feedback will arrive.

RFC-0001 already names the shape: *"No process runs between events: the
handler wakes, executes to its next await, parks"* (SURFACE.md §1), durable
awaits are first-class (RFC §1 comparison table), and an epoch summary carries
"active waits" (decision 8). What is not specified is:

1. how a body subscribes to events *after* it has started,
2. what happens to events that arrive while the body is busy running a step,
3. how a wait ends when the events simply stop coming.

The third is the babysitting question. There is no signal for "no more
feedback". A flow ends on **state** (the PR is merged, closed, or ready) and
uses **time** only as a backstop. This document makes both expressible.

"Babysit" here is the PR-maintenance job, not what covenant 3 forbids: a flow
watching its own PR runs toward a declared end (`merged`, `closed`, a declared
human gate, or a stated time bound) and never stops to ask permission for work
inside its scope.

## 2. What exists today

Verified against `main` at `85e7e372`:

- `kernel/DESIGN.md` §1.4 defines `wait.event` with `wait_id`, an exact-match
  `event_key`, and a nullable `timeout_at_ms`; §1.7 defines `wait.completed`
  with `timeout` among its reasons.
- `relayflowd-core/src/state.rs` folds `wait.event` into `StepState::Waiting`,
  and `relayflowd/src/engine/remote.rs` `emit_event` closes every open wait
  whose `event_key` matches.
- **No step produces `wait.event`.** Only `wait.human` is appended (manual
  recovery, `machine/recovery.rs`).
- **`timeout_at_ms` is never read.** A wait with a timeout would wait forever.
- **An event with no open wait is dropped.** `emit_event` returns
  `matched: 0` and journals nothing, so an event that lands while the body is
  running a fix step is lost.
- **The authored `Ctx` has no `on`.** `packages/surface/src/context.ts`
  exposes `human`, `dispatch`, and `done`; the authored executor throws
  `unsupported_verb` for `human` and `dispatch` (#400).

## 3. Surface

`on` keeps its meaning — "these events matter to this flow" — and gains a
second position. At the top level it is an entry condition (gate 2). Inside a
body it opens a **subscription**: a durable, buffered cursor over matching
events for the rest of the run.

```ts
export default flow("implement-and-babysit", async (f, input) => {
  const pr = await f.agent("implementer", { task: input.issue.title });

  const activity = f.on(github.pullRequest(pr.repo, pr.number).activity(), {
    settle: "2m",   // coalesce a burst (a review with 12 comments) into one wake
    idle: "72h",    // no matching event for 72h ends the wait
    deadline: "14d" // hard cap from the moment the subscription opened
  });

  for (let round = 1; round <= 10; round++) {
    const state = await f.github.pullRequest(pr).read();   // re-read, never trust the event
    if (state.merged || state.closed) return f.done("success");
    if (isReadyAtHead(state)) return f.done("needs_human");

    if (needsWork(state)) {
      await f.agent("babysitter", { task: renderFixTask(state) });
      continue;                                              // re-read before waiting
    }

    const wake = await activity.next();                      // parks; no process runs
    if (wake.kind !== "events") {
      await f.github.issue(input.issue).comment(stalledNotice(pr, wake.kind));
      return f.done("needs_human");
    }
  }
  return f.done("needs_human");                              // round cap reached
});
```

The subscription is closed by `activity.close()`, by `done()`, or by run
cancel. It is never left open past the run.

### `next()` result

```ts
type Wake =
  | { kind: "events"; events: readonly EventFrame[]; offset: number }
  | { kind: "idle" }       // idle budget elapsed with no matching event
  | { kind: "deadline"; pending: { from: number; to: number } | null }
  | { kind: "overflow"; retained: number; bytes: number; from: number };
                              // the bounded stream closed before dropping a frame
```

`events` is every event buffered since the previous `next()`, in arrival
order, after `settle` has elapsed with no newer arrival. `idle` also ends a
still-active settle window: when the idle instant is reached with buffered
frames, `next()` returns that one batch as `events`, rather than extending a
burst forever. `deadline` is different: it is a hard cap and wins at or after
its recorded instant; `pending` makes any durable unread range visible rather
than silently discarding it. `overflow` closes the subscription before the
would-exceed frame is appended; the body re-reads provider state and may open
a fresh bounded subscription. The flow decides what an `idle`, `deadline`, or
`overflow` means; the kernel never turns one into a failure.

### Options

| option | default | meaning |
|---|---|---|
| `settle` | `0` | after the first buffered event, wait until no further event has arrived for this long before waking; an `idle` instant with a non-empty batch ends settle and returns that batch, while `deadline` remains a hard cap |
| `idle` | required | per `next()`: wake with `idle` if no event has been buffered for this long, measured from the later of subscription open and the previous wake |
| `deadline` | required | absolute cap fixed when the subscription opens; every later `next()` wakes with `deadline` at that instant, however recently events arrived |
| `includeSelf` | `false` | deliver events caused by this run's own identity (gate 8) |

`idle` and `deadline` are required on purpose. A subscription with no end is
a run with no end, and covenant 2 (no unexpected failures, enforced by
preflight) means the author states the bound. `flows check` refuses a
body-level `on` without both, with `unbounded_subscription`.

## 4. Semantic laws

1. **Level-triggered, not edge-triggered.** An event is a wake-up, not the
   truth. The body re-reads provider state through the mount after every wake
   and before every wait. Payloads are late, reordered, and metadata-only;
   state decides. Garden's babysitter learned this the hard way and re-reads
   PR state itself on every wake.
2. **Nothing matching is lost while the subscription is open.** Events that
   arrive while the body runs another step are buffered and delivered by the
   next `next()`. The one bounded exception is an explicit `overflow`: the
   subscription closes before the would-exceed frame is accepted, and the
   body receives `overflow` rather than a silently truncated batch.
3. **Open, then read.** Events that happened before the subscription opened
   are not delivered. A body closes that gap by opening the subscription and
   then reading state, which law 1 already requires.
4. **Delivery is at-least-once and deduplicated by provider delivery id.** A
   redelivered webhook appends nothing.
5. **Self-caused events are filtered by default.** A babysitter's own push
   emits `pull_request.synchronize`; delivering it would wake the flow to
   react to itself. The router compares the event actor with the run's
   identity. Cloud's integration-watch dispatcher already applies this guard to
   PR reviewer personas.
6. **Time and delivery order are journaled, not recomputed.** Each `next()`
   journals the absolute instants it will wake at. The router's append and the
   scheduler's timer claim serialize through one per-subscription journal
   order: for `idle`, an append committed before its timer claim wins and
   returns the buffered batch; at an exact `deadline` tie the deadline wins.
   Resume re-arms those instants against the real clock (kernel DESIGN §3 step
   4); an instant that passed while the cell slept fires immediately.
7. **Waiting is free.** A parked `next()` holds no lease, no sandbox, and no
   process, and spends zero tokens. `deadline` is the cost bound; the author's
   loop cap bounds rounds of agent work.
8. **A subscription is not a trigger.** It never starts a run, and it does not
   participate in trigger-plane liveness (`staleAfterMs`). Silence on a
   subscription is an expected outcome surfaced as `idle`, not a dead trigger.

## 5. Kernel (additive)

No new step kind and no new verb. The kernel vocabulary stays closed
(decision 13).

1. **`subscription.opened`** — `subscription_id` (deterministic from run id,
   step id and declaration), `event_types`, `pattern` (the recursive-subset
   match already used by `TriggerSpec.pattern`), `stream`
   (`subscription/<subscription_id>`), `deadline_at_ms`, `include_self`, and
   the immutable provider binding: integration installation, canonical
   resource scope, authorization snapshot, router binding generation, and
   durable ingress offset. Opening is a two-party handshake: Cloud first
   records the fenced binding at that ingress offset, then the journal appends
   `subscription.opened`; `f.on()` is not visible to the body until both have
   completed. Recovery removes a prepared binding that has no matching journal
   entry, and otherwise restores the same generation and replays ingress after
   its offset before acknowledging the body. This closes the journal-to-router
   race without delivering frames that predate opening.
2. **`subscription.closed`** — `subscription_id`, `completionReason`
   (`closed` \| `run_completed` \| `canceled` \| `deadline` \| `overflow`).
3. **Buffered delivery** — matching events become `stream.appended` on the
   subscription's stream, carrying the provider delivery id as the idempotency
   key. A stream holds at most **1,000 unread frames or 1 MiB of unread encoded
   frame bytes**, measured after this subscription consumer's acknowledged
   offset; consumed prefixes are eligible for normal journal compaction and do
   not count against the next batch. On a would-exceed append, closure uses the
   converse of the open handshake: the router first durably fences the binding
   as `closing: overflow` and refuses further appends, the journal appends
   `subscription.closed(overflow)`, and only then is the binding removed. If a
   cell dies between those records, recovery completes the idempotent close
   from the fenced binding; it never restores that generation as open. The
   would-exceed frame is unappended and the next `next()` returns `overflow`
   with the retained range. Events for a closed or unknown subscription are
   refused, not buffered.
4. **`wait.event` extension** — alongside `event_key`, a wait may name
   `stream`, `from_offset`, `settle_ms`, `idle_at_ms`, and `deadline_at_ms`.
   It completes with `event_received` and `result: { from_offset, next_offset }`
   once the stream has entries at or past `from_offset` and `settle_ms` has
   passed since the newest of them. An idle claim with a non-empty unsettled
   batch completes the same way, so continuous arrivals cannot extend settle
   forever. An exact or later deadline claim completes with `timeout` and
   `result: { timeout: "deadline", pending }`, even when unread entries
   exist; idle completes with `result: { timeout: "idle" }` only when no
   buffered entries won the serialized race. Adding result fields keeps
   `wait.completed`'s reason enum unchanged.
5. **Timeouts are enforced.** The scheduler arms `timeout_at_ms`,
   `idle_at_ms`, and `deadline_at_ms` as durable timers for every open wait,
   including `wait.human`. This closes the gap in §2 for existing waits too.
6. **Epoch summary** carries open subscriptions with their stream offsets and
   deadlines alongside `open_waits`.

## 6. Router contract (Cloud)

The event router is Cloud's, not the kernel's (decision 15: the kernel is
tenant-unaware).

- A `subscription.opened` entry is projected to the router as a fenced binding
  of `(run_id, subscription_id, generation, ingress_offset)` to its event
  types, pattern, provider installation, and canonical resource scope. It is
  removed on `subscription.closed`. The open handshake records the binding and
  ingress offset before the body can observe the subscription; recovery
  replays ingress strictly after that offset before acknowledging the binding.
- The router matches incoming `EventFrameV1` frames against open bindings,
  first proving the frame came through the bound installation and is within
  the bound resource scope. It then applies the self-actor filter and calls
  `stream.append` with the provider delivery id. A user-authored pattern never
  broadens that installation or resource scope. A matching frame for a
  sleeping cell wakes the cell.
- The router never decides whether the flow is done. It only delivers.

## 7. Acceptance

The crash-injection suite is the gate (AGENTS.md standard 5). A conforming
implementation proves:

1. An event emitted while the body is running a step is delivered by the next
   `next()`.
2. `kill -9` after `stream.appended` and before the wait completes, then
   resume: the event is delivered exactly once to the body.
3. `kill -9` with an open wait whose `idle_at_ms` passes during the outage:
   resume wakes with `idle` immediately and does not re-run earlier steps.
4. `idle` measures from the previous wake; `deadline` does not move when events
   arrive.
5. Three events inside `settle` produce one wake carrying all three.
6. A redelivered frame with the same delivery id appends nothing.
7. An event whose actor is the run's identity is not delivered unless
   `includeSelf` is set.
8. After `close()` or `done()`, a matching frame is refused and nothing is
   appended.
9. A body-level `on` without `idle` or `deadline` fails `flows check` with
   `unbounded_subscription`.
10. `wait.human` with `timeout_at_ms` completes with `timeout` at that instant.
11. A frame that arrives after the router binding is prepared but before the
    body can observe `f.on()` is replayed from the recorded ingress offset;
    a crash at either side of that handoff produces neither a ghost binding nor
    a missed post-open frame.
12. The 1,001st frame or first byte beyond 1 MiB closes the subscription and
    returns `overflow` when that many **unread** frames or bytes are pending;
    a consumer that keeps up does not overflow on lifetime volume. No frame is
    silently dropped and later matching frames are refused until the body
    explicitly opens a fresh subscription.
13. A frame racing an idle timer follows the serialized append/timer order;
    a non-empty batch at idle ends settle as `events`. A frame at the exact
    deadline loses to `deadline`, whose result reports any durable unread
    range.
14. `kill -9` after the router fences an overflow but before
    `subscription.closed(overflow)` commits, then resume: recovery completes
    the overflow close and never restores the prior binding as open.

## 8. Open questions

- **Pattern language.** v0 `wait.event` is exact-match; triggers already carry
  a recursive-subset `pattern`. Leaning: reuse `pattern` for subscriptions and
  keep `event_key` for exact-match waits.
- **Relationship to `f.human`.** #400 needs a durable approval wait. Leaning:
  `f.human(question, { to, timeout })` lowers to `wait.human` with the timers
  from §5.5, and resolves to `false` on timeout.
