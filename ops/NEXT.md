# NEXT — WP-GATE2-POLLER: Implement HN poller to make hn-monitor actually monitor

**Target gate:** Gate 2 (per ops/TARGET.md — this run is pinned to gate 2 only)

**Work package:** WP-GATE2-POLLER — Implement deterministic HN poller

## Objective

Implement a deterministic poller that fetches `https://hacker-news.firebaseio.com/v0/topstories.json`, takes the first few story IDs, and submits each through `Engine::submit_event` so hn-monitor wakes on real HN data with dedupe.

**Context from ops/TARGET.md:** PR #15 landed `testdata/hn-monitor.flow.yaml` and `kernel/relayflowd/tests/hn_monitor_integration.rs`, but the triggering event comes from test code, not Hacker News. Gate 2 is AMBER. **The previous run wrote a work package and no code — do not repeat that. This is a CODE task: write the missing poller.**

**Current state:** The `Engine::submit_event` path exists and works (kernel/relayflowd/src/engine/wake.rs:19). The hn-monitor flow exists and the integration test proves event → wake → park works. **The only missing piece is the poller that fetches real HN data and calls submit_event.**

## Files in scope

**New file to create:**
- `kernel/relayflowd/src/engine/hn_poller.rs` — poller implementation

**Files to modify:**
- `kernel/relayflowd/src/engine.rs` — add `mod hn_poller;` and `pub use hn_poller::HnPoller;`
- `kernel/relayflowd/src/lib.rs` — re-export HnPoller if needed
- New test file or extend existing test to prove offline operation with recorded payload

## Definition of done (all three required per ops/TARGET.md)

1. **A new committed source file** implementing the poller exists at `kernel/relayflowd/src/engine/hn_poller.rs` with:
   - Fetch `https://hacker-news.firebaseio.com/v0/topstories.json` (returns `Vec<u64>` story IDs)
   - Take first N IDs (configurable, default 5)
   - For each ID, construct an `Event` matching hn-monitor's trigger pattern:
     - `event_type: "hn.story_posted"`
     - `payload` with at least `{"id": <story_id>, "type": "story"}` (matches pattern in hn-monitor.flow.yaml:9)
   - Submit via `Engine::submit_event` with the hn-monitor spec
   - Dedupe works: same story submitted twice yields `matched: true, deduped: true` on second call

2. **`cd kernel && sh ../ops/cargo.sh test` passes** including a test that exercises the poller offline from a recorded payload (no live network call in test). Test should verify:
   - Parsing topstories JSON (`[41380628, 41378954, ...]`)
   - Constructing events with correct structure
   - Submitting through submit_event
   - Dedupe behavior (second submit is deduped)

3. **The run's diff contains real code outside ops/**: The poller must be substantive Rust code, not just documentation.

## Implementation approach

- **Deterministic and testable**: Use a trait or function parameter to inject the JSON source, allowing tests to supply a recorded payload instead of hitting the network
- **Minimal scope**: ONE cycle (~10 minutes). Small working poller beats large plan.
  - No daemon/background loop (just a sync function that polls once)
  - No full story metadata fetching (topstories only gives IDs; construct minimal events)
  - No retry/backoff logic (fail fast is fine for this proof)
- **Error handling**: If fetch fails, return an error
- **Payload structure**: Match what hn_monitor_integration.rs expects (see testdata/hn-monitor.flow.yaml pattern)

## Explicitly OUT of scope

- Daemon/background polling infrastructure
- Full HN story metadata (individual `/v0/item/{id}.json` fetches)
- Retry/backoff for network failures
- CLI commands to invoke the poller
- Configuration files
- Changes to hn-monitor flow spec or existing tests (beyond adding the poller test)
- Any RFC or charter edits
- Gates 1, 3-9

## Why this is the right work package

Per ops/TARGET.md: "PR #15 landed testdata/hn-monitor.flow.yaml... but the triggering event comes from a test rather than Hacker News, so gate 2 is AMBER. Write the missing piece: a deterministic poller..."

Gate 2's done-when (RFC-0001 §3): "a real proactive workload runs as a relayflow." The flow exists, the wake path works, but it's not monitoring anything real yet. The poller completes the circuit.

**ONE cycle, about ten minutes — a small working poller beats a large plan.**
