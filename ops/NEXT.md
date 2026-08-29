# NEXT — WP-GATE3-BACKLOG-PICKER: First honest step toward Software Garden

**Target gate:** Gate 3 (per ops/TARGET.md — this run is pinned to gate 3 only)

**Work package:** WP-GATE3-BACKLOG-PICKER — Build a flow that reads ops/BACKLOG.md and emits a structured work package

## Objective

Gate 3 per RFC-0001 §3 is "a relayflow can power a factory → Software Garden." The done-when is a labeled issue flowing to a reviewed PR end-to-end. ops/TARGET.md directs: "Do the SMALLEST honest first step, not the whole thing. Good candidate: a flow that reads ops/BACKLOG.md, picks one entry by a deterministic rule, and emits a structured work package."

**This is that smallest step**: a flow file that demonstrates gate-3 machinery (flows that build and improve other flows) without attempting the full discover→implement→review→merge DAG.

## Current state

- Gates 1 (GREEN) and 2 (AMBER, in progress) have working primitives on main
- Gate 3 is RED (not started) per ops/SCOREBOARD.md
- ops/BACKLOG.md exists with structured entries
- No gate-3 flows exist yet

## Files in scope

**New files to create:**
- `testdata/backlog-picker.flow.yaml` — the flow spec that reads ops/BACKLOG.md and selects one entry
- `testdata/backlog-picker.spec.canonical.json` — canonical compiled spec (via `flows check`)
- `sdk/tests/backlog-picker.test.ts` — test proving deterministic selection given the same input

**Files to modify:**
- None required for the minimal step

## Definition of done (all three required per ops/TARGET.md)

1. **`flows check` resolves the flow** — `testdata/backlog-picker.flow.yaml` passes preflight validation with exit 0

2. **A test proves selection is deterministic** — `sdk/tests/backlog-picker.test.ts` demonstrates that:
   - Given the same ops/BACKLOG.md content, the flow always selects the same entry
   - The selection rule is deterministic and documented (e.g., "first non-done entry", "alphabetically first", or similar)
   - The test verifies structured output (the work package emitted has required fields)

3. **`cd sdk && npm test` green** — all SDK tests pass including the new backlog-picker test

## Implementation approach

The SMALLEST working implementation:

- **Flow structure:**
  ```yaml
  spec_version: "1.0"
  name: backlog-picker
  steps:
    - name: read-backlog
      type: deterministic
      command: "cat ops/BACKLOG.md"
    - name: select-entry
      type: deterministic
      command: # deterministic selection logic (e.g., first non-done entry)
    - name: emit-package
      type: deterministic
      command: # output structured work package JSON
  ```

- **Deterministic rule examples:**
  - First entry in the file
  - First entry matching a pattern
  - Alphabetically sorted first
  - Line-number based

  Choose the simplest that is defensible as "deterministic"

- **Output format:** Structured JSON work package with fields like:
  - `title`: work package name
  - `description`: what needs to be done
  - `files_in_scope`: estimated file paths
  - `gate`: which gate this serves

## Explicitly OUT of scope

- LLM or agent steps (gate 1 is deterministic-only for now)
- GitHub integration (creating actual issues or PRs)
- The full discover→implement→review→merge DAG
- Issue labeling, assignment, or tracking
- Integration with the existing drive.yaml workflow
- Any changes to kernel code
- Changes to gates 1, 2, or 4-9
- ops/FORBIDDEN_PATHS violations (no kernel/relayflowd/src/engine/hn_poller.rs)

## Why this is the right work package

Per ops/TARGET.md: "Gate 3 per RFC-0001 is the Garden: flows that build and improve other flows. Do the SMALLEST honest first step, not the whole thing. Good candidate: a flow that reads ops/BACKLOG.md, picks one entry by a deterministic rule, and emits a structured work package."

This work package:
- Stays strictly within gate 3 scope (SOFTWARE GARDEN foundation)
- Is a CODE task as required
- Does the smallest honest first step
- Demonstrates "flows that build and improve other flows" (reading a backlog is the first step toward self-proposing work)
- Has a clear, testable definition of done
- Avoids all CONSTRAINTS from ops/TARGET.md (no server.rs, no hn-poller files)

**ONE cycle, ten minutes.**
