# nightly-implementer

Design artifact for how flows should orchestrate its own implementation
work overnight. Filed on 2026-09-10 as a target shape; the primitives it
uses land in the same launch wave (flows#273 `f.llm`, flows#275
declarative value binding, structured `output` schemas on agent steps).
Until those close, treat this as intent rather than a runnable script.

## What the shape proves

Every decision that lets code advance toward merge is a **deterministic
step reading typed JSON**. The agents produce blockers, reasons, and diffs;
they never adjudicate their own work. That's the whole point.

Stage by stage:

1. **`worktree` — deterministic setup**. Checks out a fresh pinned base,
   emits `{path, baseSha}`. `json_schema` verification asserts both fields.
2. **`plan` — `f.llm` with typed output**. Compiles to a `json_schema`
   verification so a hallucinated plan that doesn't parse as
   `{files, testFiles, risks}` fails the step, doesn't bypass it.
3. **Repair loop, bounded to 3 iterations**. Each pass has:
   - **`impl` — agent step**. Typed `output` schema (`{sha, filesTouched}`).
     Prior-iteration blockers arrive via declarative binding as
     `input.blockers`.
   - **`scope-gate` — deterministic**. Compares actually-touched files
     against the declared allowlist, emits `{scopeOk}`. This is the exact
     shape flows#242 / #271 needed and the class fix #284 tracks.
   - **`verify` — deterministic**. `tsc --noEmit` + `vitest --reporter=json`.
     Verification asserts `numFailed === 0 AND tscOk === true`. An agent
     cannot bypass this by asserting success — the JSON is emitted by the
     tools themselves.
   - **Review swarm — three lenses, parallel**. Correctness / regression /
     maintainability. Different providers so shared-model bias cannot
     quorum. Each is told "default to `blocked=true`" — the
     [review-fix-signoff](../../.claude/skills/review-fix-signoff-loop)
     covenant. No lens sees another's verdict.
   - **`aggregate-review` — deterministic**. Combines three lens verdicts
     with the verify gate result into `{approved, blockers}`. Approve
     requires ALL FOUR green. Any lens without `reasons[]` alongside
     `blocked=true` is treated as blocked-with-no-reasons and still blocks.
4. **`report-blocked` — needs_human hand-off**. When the repair loop
   exhausts its budget without unanimous approval, the run terminates in
   `needs_human` (RFC-0001 gate 5, flows#251), not `step_failed`. The
   iteration count and every accumulated blocker survive on the outcome
   for a human tail.
5. **`open-pr` — agent step declaring `surfaces.external`**. Drops a JSON
   file at the relayfile mount's PR-creation path. Gate 6 elects one
   attempt via `effect.record`, journals the write, confirms via
   `effect.confirm`. Filename at the mount is the idempotency key — a
   retried attempt writes the same name and the GitHub adapter refuses
   the duplicate. **This is NOT `gh pr create` via a `deterministic`
   step**: shelling that out carries none of the effect-journal or
   idempotency guarantees.

## What the shape avoids

- **Agent-adjudicated gates**. Every merge-forward decision is a
  deterministic step reading typed JSON. No LLM rationalizes its way past
  a boolean.
- **Single-reviewer rubber-stamping**. Three lenses, distinct angles,
  distinct providers, distinct prompts.
- **Silent stalls**. `MAX_REPAIR_ITERATIONS` is finite; exhaustion is a
  distinct outcome (`needs_human`) from either success or `step_failed`.
- **Shell-escape hatch for PR opening**. Every writeback goes through the
  journaled effect protocol with filename-as-idempotency-key.
- **Free-form verification**. Every `verification:` is `json_schema` over
  a shape the producing tool emits directly, or `output_contains` against
  a specific literal.

## What still needs to land

- **flows#273** — `f.llm` in the TS surface with typed `output`.
- **flows#275** — declarative value binding (the `{step, path}` selector
  shape this file uses in every `input:`).
- **flows#274** — YAML agent local-worker path (if the batch driver is
  ever re-authored in YAML).
- **flows#284** — first-class immutable-acceptance-inputs. The scope gate
  here approximates it as a deterministic step; a proper primitive would
  make the guarantee unbypassable at the schema level rather than at the
  script level.
- **cloud#3534** — running-stall sweep. Necessary for the batch driver
  to survive a stranded sub-run without keeping the run row in `running`
  forever.

Once those five close, `flows run --local-agent nightly-batch.flow.ts` runs
this shape end-to-end.

## How to run once primitives land

```
export RELAYCAST_WORKSPACE_KEY=rk_live_...   # observer URL support
export RELAYFILE_MOUNT=/relayfile             # PR writeback path root

# One-shot batch of five issues:
flows run --local-agent examples/nightly-implementer/nightly-batch.flow.ts \
  --input '{"issues":[
    {"repo":"AgentWorkforce/flows","issue":XXX,"briefPath":"...","declaredFiles":[...]},
    ...
  ]}'
```

The `Observer:` line on stdout is the shareable live view (flows#269 /
#286). The final `RUN <id> completed` carries the aggregate summary
including per-issue outcomes.

## Provenance

Shape informed by the [review-fix-signoff-loop](../../.claude/skills/review-fix-signoff-loop),
[relay-80-100-workflow](../../.claude/skills/relay-80-100-workflow), and
[writeback-as-files](../../.claude/skills/writeback-as-files) skills — plus
the concrete drive-local defect class documented at flows#242 / #271 /
#284 and the 2026-09-10 shakedown evidence at
`evidence/shakedown-0910/` on branch `shakedown/v2-launch-0910`.
