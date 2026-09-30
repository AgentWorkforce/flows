# PR 441 — independent read-only review of the Rust router protocol additions

Reviewer: flows-501-review-0920 (assigned by sf-frame). No repository edits.
Scope: `c50312d5` "feat(events): fence router delivery and expose durable
subscription metadata" as merged in `62e78e19` (merge of origin/main
`e21caad1`), plus the `docs/EVENT-AWAIT.md` §6 "Targeted router protocol"
contract. SDK changes were out of scope (SDK worker active).

Exact heads:
- Reviewed: `62e78e193c175a853f38c00923956c63e1a8c970`
- Worktree HEAD moved to `a217c3f65fef4d9e9883b3c8e1ff3ce702934efb` during the
  review (SDK-only commit). `git diff 62e78e19 a217c3f6 --stat -- kernel docs`
  is empty, so every Rust/docs statement below holds for both heads and the
  test runs are attributable to the reviewed kernel.
- Merge check: `git diff c50312d5 62e78e19 -- kernel/relayflowd/src/engine/subscriptions kernel/relayflowd/src/server.rs kernel/relayflowd/src/server/wire.rs kernel/relayflowd/src/server/protocol.rs`
  shows only main's #500 worker-eligibility hunks (`required_streams`); the
  router additions came through the merge untouched.

Files read in full: `engine/subscriptions/{router_delivery,mod,state,local_router,parking,wait_timers}.rs`,
`server.rs` (new verbs + lock usage), `server/protocol.rs`, `server/wire.rs`,
`tests/subscription_router_delivery.rs`, `server/tests/subscription_router.rs`,
`engine.rs` resume path, `docs/EVENT-AWAIT.md` §5–§6.

## Verdict

No blocking correctness bug found in fencing, dedup, timers, journal or
restart handling for the three new verbs. The behaviour matches the §6
contract on every point I could exercise, including the one crash window the
tests do not cover (fence torn from its close), which the code already
repairs. Findings below are one projection gap (medium-low), one error-code
mapping nit, and test-coverage gaps; none change journal facts.

## Evidence (literal commands + complete output)

- `/tmp/flows-441-review-evidence/router-tests-62e78e19.txt` —
  `cargo test -p relayflowd --test subscription_router_delivery` (2/2),
  `--lib server::tests::subscription_router` (1/1),
  `--test event_activities` (11/11), all exit 0, run from a scratchpad
  `CARGO_TARGET_DIR` so nothing was written into the PR worktree.
- `/tmp/flows-441-review-evidence/torn-fence-probe.txt` — external Rust probe
  (path dependency on the PR kernel, source included in the file) producing
  the torn state with the doc-hidden single-append
  `Engine::fence_subscription_overflow` and printing what each verb does.
  Output, verbatim:

  ```
  first next() -> true
  after torn fence: fenced=1 closed=0
  deliver on torn fence -> Err(subscription_closed)
  inspect on torn fence -> state="active" completionReason=null
  after fence retry: fenced=1 closed=1
  inspect after retry -> state="closed" completionReason="overflow"
  next() after retry -> Wake(Overflow { retained: 1, bytes: 35, from: 0 })
  resume on torn fence -> status=Parked closed=1 wait.completed=1
  PROBE_OK
  ```
- Owner's full post-merge kernel workspace run:
  `/tmp/flows-fleet-evidence/pr441/kernel-after-main.txt` (exit status 0;
  includes `subscription_router::targeted_router_verbs_validate_receipts_and_preserve_wire_metadata ... ok`).

## What holds (checked against code, not the PR description)

1. **Fencing.** `deliver_subscription_frame` refuses unknown/prepared
   (`subscription_not_active`), stale receipt (`subscription_binding_mismatch`,
   structural `serde_json::Value` equality, key-order independent), and closed
   or overflow-fenced (`subscription_closed`) — all before any append, and the
   refusal appends nothing (engine test asserts journal length unchanged).
   Activation retry requires both `router_binding` and `ingress_offset` to
   match; a subscription id is opened at most once per run, so a binding can
   never be replaced. `#[serde(deny_unknown_fields)]` on all three param
   structs.
2. **Dedup.** `provider_delivery_id` is checked per stream across the whole
   journal *before* the overflow check, so a duplicate never triggers a fence
   and returns `{appended:false, reason:"duplicate"}`; survives restart
   (engine test). Same key space as the local `event.emit` adapter, so a frame
   arriving through both paths is one frame.
3. **Overflow.** Bounds are `unread >= 1000` frames or `unread_bytes +
   encoded > 1 MiB`, measured from `acknowledged_offset`; the would-exceed
   frame is unappended; fence entry then close entry; the server maps the
   post-close snapshot to `reason:"overflow"`. `fence_router_subscription_overflow`
   is idempotent on a closed receipt (any reason — a normal close that won
   the race is a no-op, as §6 requires) and completes a torn fence.
4. **Torn fence (crash between `subscription.overflow_fenced` and
   `subscription.closed`).** Not covered by a test, but handled: deliver is
   refused, a Cloud fence retry completes the close exactly once, and a plain
   `resume` completes it via `claim_subscription_timeouts` →
   `complete_fenced_overflows_in_journal`, settling the open `wait.event` with
   `wake: overflow`. The probe output above is the proof.
5. **Timers.** `inspect` takes `idleAtMs` from the durable wait, else
   `last_wake_at_ms + idle_ms` from the journal — never the query clock
   (engine test pins snapshot equality across a restart with a moved clock).
   No new timer is armed or claimed by the new verbs; delivery only appends,
   consistent with "the router never decides whether the flow is done".
6. **Locking.** All three verbs take `hub.run_lock(run_id)` for the whole
   validate-then-append sequence; `deliver` also `ensure_mutable`. Within the
   daemon that serializes against `subscription.next`, `event.emit`,
   activation, the reconciler's `resume_live` and worker abandonment.
7. **Restart.** Every decision is re-derived from the journal fold on each
   call (`subscriptions()`/`prepared_subscriptions()`); the hub lock map being
   process-local is fine because there is no in-memory router state to lose.

## Findings

### F1 (medium-low) — `subscription.inspect` hides the overflow fence
`inspect_subscriptions` reports `state: "active"` with no `completionReason`
for a subscription whose `SubscriptionOverflowFenced` entry landed but whose
`SubscriptionClosed` has not (probe line: `inspect on torn fence ->
state="active" completionReason=null`), while `subscription.deliver` on the
same state returns `subscription_closed`. §5.4 defines "fenced as
`closing: overflow`" as a distinct state and §6 says `inspect` exists "for
scheduling and cleanup"; a Cloud scheduler reading this projection would keep
the binding open and schedule idle wakes for a subscription the kernel already
refuses. Recovery is unaffected (F-holds 4), so this is a legibility/contract
gap, not data loss. Suggest `state: "closing"` (or an `overflowFenced: true`
field) plus `completionReason: "overflow"` when `state.overflow_fence.is_some()
&& state.closed.is_none()`, and a test asserting it.
Location: `kernel/relayflowd/src/engine/subscriptions/router_delivery.rs`
`inspect_subscriptions`, the `"state"` expression.

### F2 (low) — empty `delivery_id` surfaces as `internal_error`
`append_subscription_frame` bails on an empty `delivery_id` with a plain
`anyhow` error, which `subscription_router_error` maps to the internal code;
Cloud sees an internal failure for a client mistake. `deliver_subscription_frame`
validates the receipt first and only then reaches this check, so it is
consistent but mis-coded. Suggest validating non-empty `delivery_id` in the
`subscription.deliver` handler as `bad_request`, like other param checks.

### F3 (low) — unlocked engine use has a validate/append window
`deliver_subscription_frame` drops the journal after validation and
`append_subscription_frame` reopens it. Under the server's run lock this is
harmless. A caller that embeds `Engine` directly without that lock (the engine
API is `pub`) can interleave a close between the two; the append path
re-checks closed/fenced and returns `Ok(false)`, which the server layer would
label `"duplicate"`. Nothing is appended wrongly. Worth a doc comment on the
`pub fn` stating the lock precondition (the existing comment says "the
protocol run lock serializes…", which is true only for protocol callers).

### F4 (test gaps, no code defect)
- No test tears the fence from its close (F-holds 4). The probe shows the
  behaviour is right; it should be pinned, the same way #501 pinned its torn
  park (`state::park_placeholder_wait_id` repair). A single-append
  `fence_subscription_overflow` + restart + `deliver`/`resume`/fence-retry
  assertion is ~30 lines in `tests/subscription_router_delivery.rs`.
- The wire-level `reason:"overflow"` branch of `subscription.deliver`
  (server.rs) is not exercised; the engine-level overflow is
  (`event_activities::overflow_closes_before_the_1001st_unread_frame…`).
  The mapping is three lines, but it is the only place the doc's
  `{appended:false, reason:"overflow"}` promise is implemented.
- `subscription.inspect` for a `prepared` id is asserted only in the engine
  test; the wire test starts from two active ones.

### F5 (doc/journal drift, pre-existing, not introduced by c50312d5)
§5.4 says the overflow settle journals `result: { wake: "overflow", retained,
bytes, from }`; `close_subscription_in_journal` journals
`{subscription_id, wake: "overflow"}` and the surface reads `retained/bytes/from`
from the fence entry instead. The body still receives the right values, so
this is the doc describing a shape the journal does not carry. Either journal
the three fields on the completion or amend §5.4 to say they come from
`subscription.overflow_fenced`.

### Notes (no action needed)
- `inspect` sorts by `subscriptionId` as a string; ids are `f.on()` call
  ordinals, so `"10"` sorts before `"2"`. Cloud should key by id, not index.
- A single frame larger than 1 MiB on an empty stream closes the subscription
  as overflow with `retained: 0`. That follows the contract literally
  ("would-exceed append"); flagging only so the behaviour is a known choice.
- `subscription.fence_overflow` does not call `ensure_mutable`; on a terminal
  run the subscription is already closed by `close_subscriptions_for_terminal`,
  so it returns `fenced: true` as an idempotent no-op — correct, just
  asymmetric with `deliver`.
- The kernel arms no settle timer after a router delivery; a parked body is
  woken by Cloud's resume (per §6) or by the durable idle/deadline instants.
  `inspect` gives `settleMs`, `idleAtMs`, `deadlineAtMs` but not "settle due
  at" — Cloud can derive it from its own delivery time. Pre-existing design,
  consistent with the docs; recorded so nobody expects the daemon to wake on
  settle by itself.
