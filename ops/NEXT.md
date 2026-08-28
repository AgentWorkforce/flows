# NEXT — WP-GATE2-1: Proactive agent event subscription (gate 2)

**Target gate:** Gate 2 (per ops/TARGET.md — this run is pinned to gate 2 only)

**Work package:** WP-GATE2-1 — Implement event-triggered flow execution

## Objective

Build the foundational event subscription machinery for gate 2: a flow declares an event subscription; the kernel wakes it on a matching event; the agent step receives context assembled AT WAKE from an epoch summary plus the triggering event (not a resumed session); the wake is journaled as a fact; and a test proves a second identical event does not double-execute the effect.

## Files in scope

### Kernel (Rust):
- `kernel/relayflowd-core/src/spec.rs` — extend `TriggerSpec` from a parse-only stub (current: `{id, executor}`) to a real event matcher with event type/pattern fields
- `kernel/relayflowd-core/src/entry.rs` — add entry types for event ingress (`event.received`) and subscription state (`subscription.registered`, `subscription.matched`)
- `kernel/relayflowd/src/engine.rs` — implement event matching logic and wake semantics (match incoming event → spawn run OR wake existing run at next epoch boundary)
- `kernel/relayflowd/src/server/wire.rs` + `protocol.ts` — add protocol verbs for event submission (`event.submit`) and subscription management
- NEW: `kernel/relayflowd-core/src/event.rs` — event matching engine (pattern types, matcher implementations)
- NEW: `kernel/relayflowd/src/engine/wake.rs` — wake-from-event path with context assembly (epoch summary + triggering event payload)

### SDK (TypeScript):
- `sdk/src/spec.ts` — extend `TriggerSpec` interface to include event subscription fields (event type, pattern, dedupe key template)
- `sdk/src/compile.ts` — compile YAML trigger declarations to kernel spec format
- `sdk/src/protocol.ts` — add `event.submit` request/response types
- `sdk/src/validate.ts` — validation rules for trigger specs (non-empty executor, valid event patterns)

### Tests:
- NEW: `kernel/relayflowd/tests/event_wake.rs` — the acceptance test: subscribe to event type X, submit event, assert wake happened and was journaled; submit identical event, assert NO second execution (idempotency by event dedupe key)
- `sdk/tests/live-kernel.test.ts` — extend to cover event submission and subscription lifecycle

### Testdata:
- NEW: `testdata/event-triggered-flow.yaml` — minimal flow with one trigger subscription and one agent step that logs the triggering event payload
- NEW: `testdata/event-triggered-flow.spec.canonical.json` — compiled spec for parity test

## Definition of done

All of the following must pass:

1. **Kernel tests pass:**
   ```bash
   cd kernel && cargo test --workspace
   ```
   Must include the new `event_wake.rs` test proving:
   - Event submission reaches a subscribed flow
   - Wake is journaled as `event.received` + `run.spawned` OR `wait.event` + `wait.completed`
   - Context at wake = epoch summary + event payload (not a resumed agent session)
   - Identical event submitted twice → exactly one execution (dedupe by event key)

2. **SDK tests pass:**
   ```bash
   cd sdk && npm test
   ```
   Must include:
   - Trigger spec validation (reject empty executor, invalid patterns)
   - Event-triggered flow compiles to canonical spec and hashes correctly
   - Live kernel test: submit event, poll run state, assert completion

3. **Spec parity holds:**
   The event-triggered testdata flow compiles in SDK and parses in kernel with identical `spec_hash` (existing `spec_parity.rs` test extended to cover the new fixture)

4. **Integration proof:**
   ```bash
   cd kernel && cargo run -- run testdata/event-triggered-flow.spec.canonical.json --event '{"type":"test.ping","payload":{"message":"hello"}}'
   ```
   Must:
   - Spawn the run
   - Execute the agent step with event payload in context
   - Journal `event.received` entry with the event and matched subscription id
   - Complete successfully
   - Second invocation with same event → no new run (dedupe)

5. **No regressions:**
   All existing tests (deterministic, llm, agent crash-resume) still pass. Gate 1 remains green.

## Explicitly OUT of scope for this work package

- **Webhook ingress** — gate 2's done-when mentions "Webhook (`EventFrameV1` via relayfile's webhook server)" but that is the FULL gate 2 scope, not this package. This WP focuses on the KERNEL event machinery. Webhook routing is a separate package.
- **Persona import** — gate 2 also specifies "persona import" as first-class; that is likewise a different WP (SDK surface + kernel integration).
- **Trigger liveness checking** — RelayCron's `stale_after` reconciliation is mentioned in gate 2's done-when but is NOT required for basic event wake. Defer to a later WP.
- **Multi-event orchestration** — one event type, one subscription, one wake. Complex event patterns (all-of, any-of, time windows) are future.
- **Stream-based coordination** — RFC decision #7 says "channels are kernel streams" but gate 2 does not require durable channels to be implemented. Agent-to-agent messaging stays out of scope.
- **hn-monitor migration** — gate 2's done-when says "hn-monitor runs as a relayflow in production" but that is the GATE ACCEPTANCE, not this WP. This WP builds the primitives; a follow-up WP migrates hn-monitor onto them.
- **Gates 1, 3-9** — this run is pinned to gate 2; work on any other gate is a collision with sibling runs.

## Current state analysis

**What exists:**
- `TriggerSpec` struct exists in `kernel/relayflowd-core/src/spec.rs:338` but is a stub: `{id: String, executor: String}` with no event matching fields
- Triggers are validated (non-empty id/executor, no duplicates) but never consumed — the comment on line 37 says "Inert gate-1 declarations. Matching and dispatch belong to gate 2."
- Entry types exist for `wait.event` and `wait.completed` (lines 16, 22 in `entry.rs`) suggesting event-waiting was already sketched
- Journal entry payload is `Value` (JSON) so event payloads can be stored as-is

**What is missing (this WP builds):**
- Event matching logic (pattern types, matcher)
- Event submission protocol verb
- Wake-from-event path in the engine
- Context assembly at wake (epoch summary + event)
- Idempotency by event dedupe key
- Tests proving the above

**Known issues:**
- SDK tests currently fail (`error TS2688: Cannot find type definition file for 'node'`) — likely missing `@types/node` in devDependencies or bad tsconfig. Must fix before claiming tests pass.
- No cargo in sandbox environment (STATE.md known fault #2) — kernel tests will run via `ops/cargo.sh` wrapper when that exists, or tests run locally and reported honestly.

---

**Next step after this WP:** Either fix any review-identified issues in the resulting PR, OR (if this PR merges clean) WP-GATE2-2: webhook ingress integration (relayfile webhook server → kernel event submission).
