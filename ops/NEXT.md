# NEXT — WP-GATE2-FINAL: Real workload proof for gate 2

**Target gate:** Gate 2 (per ops/TARGET.md — this run is pinned to gate 2 only)

**Work package:** WP-GATE2-FINAL — Build hn-monitor as event-triggered flow

## Objective

Close gate 2 by building a **real proactive workload** that runs as a relayflow. Gate 2 primitives are DONE per ops/STATE.md (engine/wake.rs assembles wake-time context; kernel/relayflowd/tests/event_wake.rs proves one wake per unique event). RFC-0001 §3 gate 2 done-when requires the real workload, not just primitives.

Build **hn-monitor** as the smallest honest event-triggered flow that:
- Subscribes to HN story events (simulated or real webhook payload structure)
- Wakes on matching event
- Performs a real agent task (analyze story, check criteria, post summary)
- Exercises the wake path end-to-end

Constraint: ONE cycle (~10 minutes of build time) — build the smallest true version, not a complete production system.

## Files in scope

### New flow file:
- `testdata/hn-monitor.flow.yaml` — event-triggered flow with:
  - Trigger subscribing to `hn.story_posted` event type
  - Pattern matching for stories (e.g., minimum score threshold)
  - Dedupe key template to prevent double-processing
  - Agent step that analyzes the story from wake context
  - Simple verification (e.g., output must mention the story title)

### SDK:
- `sdk/src/compile.ts` — ensure event-triggered flows compile correctly (likely already works)
- `sdk/dist/cli.js` — must resolve the hn-monitor flow via `check` command

### Kernel test:
- `kernel/relayflowd/tests/hn_monitor_integration.rs` (NEW) — integration test that:
  - Loads the hn-monitor flow spec
  - Submits a simulated HN event via `submit_event`
  - Asserts the run spawns and reaches Parked state
  - Verifies journal entries (EventReceived, SubscriptionMatched)
  - Verifies wake context contains the event payload
  - Submits duplicate event, asserts dedupe works (no second run)

OR extend existing `event_wake.rs` to use the hn-monitor flow instead of event-triggered-flow.

## Definition of done

All of the following must pass:

1. **Flow file exists and resolves:**
   ```bash
   cd sdk && node dist/cli.js check ../testdata/hn-monitor.flow.yaml
   ```
   Must succeed with preflight warnings (no executor registered, CLI missing) but NOT refuse for schema violations.

2. **Kernel test passes:**
   ```bash
   cd kernel && sh ../ops/cargo.sh test
   ```
   Including a test that drives hn-monitor through `submit_event` with a realistic HN story event payload.

3. **The flow is honest, not mock:**
   - Event payload structure matches real HN webhook format (story id, title, url, score, etc.)
   - Agent instruction is a real task: "Analyze this HN story and determine if it's relevant to AI agents/automation. Output a summary with: story title, relevance score (1-10), and reasoning."
   - Verification gate checks that output contains required fields
   - NOT a no-op or echo step

4. **Wake path is exercised end-to-end:**
   - Event submission → pattern matching → subscription claim → wake context assembly → agent receives triggering event in context
   - All proven by journal inspection in the test

5. **No regressions:**
   All existing tests still pass. Gate 1 remains green.

## Explicitly OUT of scope

- **Production deployment** — this is a flow file that proves the pattern, not deployed infrastructure
- **Real HN API integration** — simulated events are fine; no network calls to HN required
- **Webhook server** — event submission is via kernel's `submit_event` API, not HTTP webhook ingress (that's a future WP)
- **Multiple triggers or complex patterns** — one trigger, one pattern, one subscription
- **Trigger liveness/staleness detection** — defer to later
- **Persona import** — defer to later
- **hn-monitor's full feature set** — build the **smallest honest version** that exercises the wake path, not feature-complete hn-monitor
- **Gates 1, 3-9** — this run is pinned to gate 2

## Current state

**What exists:**
- Event primitives: wake.rs, event.rs, dedupe, pattern matching (PR #14, merged)
- Test proving primitives: event_wake.rs passes (verified 2026-08-28 23:40 UTC per STATE.md)
- Generic event-triggered-flow.yaml demonstrates the mechanics

**What's missing (this WP delivers):**
- A real workload flow (hn-monitor) vs. a generic test fixture
- The bar shift from "primitives work" to "real workload runs as a relayflow" (RFC-0001 §3 rule 2)

**Risk assessment:**
- Time budget: ~10 minutes compile time
- Scope: Can be minimal — one trigger, one step, honest task
- Known working: event_wake.rs already proves the kernel path works
- This WP is about authoring the flow and proving it compiles/resolves, not building new kernel code

## Next step after this WP

If this WP completes and gate 2 is green, the Lead writes ops/GATE2-EVIDENCE.md documenting:
- Flow file path
- Test proving it works
- RFC-0001 §3 gate 2 done-when satisfied: "a real proactive workload runs as a relayflow"

If blocked or the real hn-monitor scope is too large for one cycle, report in ops/NEEDS_HUMAN.md and still end with ASSESS_DONE.
