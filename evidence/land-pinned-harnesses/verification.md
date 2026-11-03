# Land model-pin fix-forward verification

Land supports Claude and Codex; Codex remains the default. Grok and Devin stay
reserved configuration names and refuse before review or fix work. There is no
new SDK/Surface capability API and no additional release dependency in this PR.

The land-specific model waiver is removed. Fix calls use literal supported
pairs: Claude/claude-sonnet-5 and Codex/gpt-5.6-sol. parseLandConfig refuses
configured fixLoop.model values as not supported yet. The needs_human test
asserts FLOW_OPENAI_API_KEY exactly. No land deployment was changed.

## Reproduce

After installing dependencies in this checkout, run from the repository root:

```sh
export TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/relayflows-land-proof"
mkdir -p "$TMPDIR"
npm run typecheck --prefix examples/land
npm test --prefix examples/land
(cd packages/sdk && node node_modules/vitest/vitest.mjs run tests/shipped-source-models.test.ts)
```

The records below preserve the literal original commands and raw output, as
required by AGENTS.md. Their absolute paths identify this run and are not
prerequisites on another machine.

## Land tests and types

Working directory: repository root.

```sh
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness npm run typecheck --prefix examples/land && TMPDIR=/Users/khaliqgant/.cache/devin-harness npm test --prefix examples/land; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-claude-codex-only.log
```

```text

> typecheck
> tsc -p tsconfig.json


> test
> node --experimental-strip-types --test tests/*.test.ts

✔ defaults: mergePolicy is shadow, placeholders are the spec proposals (1.357ms)
✔ a full relay-desktop shaped config round-trips (0.234875ms)
✔ model overrides are explicitly unsupported for every harness (0.942709ms)
✔ refusals: unknown keys, bad enums, unsafe paths, out-of-range numbers (1.429458ms)
✔ JSON schema matches the runtime validator: keys, required, enums and defaults (0.192791ms)
✔ every PLACEHOLDER default names its open question (0.643625ms)
✔ clean shadow run: one hosted run per stage, E would dispatch, squash plan written, never pushed (8.6635ms)
✔ intent isolation: only context review is given intentFile; the adversarial fleet never sees it (4.029333ms)
✔ fix loop: the fixup head is carried between runs in land.bundle, then the gate reruns clean (1.453834ms)
✔ non-convergence: a finding surviving 2 rounds ends needs_human with a ≤150-byte ask (4.942166ms)
✔ formatter guard: a fix round touching files outside change ∪ findings ends needs_human (1.094542ms)
✔ changelog required with no new Unreleased bullet becomes a finding for the fix loop (2.209084ms)
✔ stage D: a moved base rebases and regates; a conflict ends needs_human (2.662709ms)
✔ superseded: the land ref moved → cancelled before any work in that run (0.173667ms)
✔ idempotent cursor: a retried stage whose state write landed is a no-op; a reaped one reruns (0.604625ms)
✔ stage E in shadow: records what it would dispatch, launches nothing, moves on to F (0.450083ms)
✔ the removed githubGateInShadow flag is refused as an unknown key, before any work (0.136542ms)
✔ refusals: no state outside A-adversarial, approval mode, state or intent inside the checkout, wrong run (0.442334ms)
✔ runId: an explicit Cloud id names the Land-Run trailer and every completion detail, not the stateDir path (0.396375ms)
✔ runId: absent, it falls back to the stateDir segment for local use (0.45225ms)
✔ runId: a malformed id, or a stateDir segment that is not one, is refused before any work (0.134167ms)
✔ runId: a stage invoked with another run id is refused and leaves the state alone (0.134666ms)
✔ $HOME paths: expanded from the run's own HOME, read once per run through a journaled step (2.149583ms)
✔ $HOME paths: a trailing slash on HOME is normalized (0.464834ms)
✔ $HOME paths: absolute paths never read HOME (1.196292ms)
✔ $HOME paths: refused when HOME is unset, relative, or unsafe (0.241625ms)
✔ $HOME paths: only the exact $HOME/ prefix; no other variable, form or .. segment (0.274792ms)
✔ $HOME paths: the outside-checkout check runs on the expanded path (0.096458ms)
✔ absolute paths: a . or .. in any segment is refused, including the first (/../x) (0.143458ms)
✔ the base fetch deepens a shallow checkout and names only the base refspec (248.571333ms)
✔ auto: dispatch overruns, the next E awaits the pushed snapshot, F squash-pushes and lands (3.625417ms)
✔ auto: a gate that finishes inside the dispatch window applies its verdict in the same run (0.547583ms)
✔ auto: red GitHub gate goes to the next fix round (0.880583ms)
✔ auto: a failed dispatched run is red to the fix loop (2.904625ms)
✔ auto: still-pending dispatched runs keep E as the cursor across stage runs (2.142916ms)
✔ auto: F goes back to D on non-fast-forward (1.224458ms)
✔ auto: a moved base at F goes back to D and regates (2.435791ms)
✔ auto: a non-FF, non-permission push failure ends needs_human (1.185792ms)
✔ auto and shadow: the land harness is the review fleets' clis and the fix agent's cli (1.547375ms)
✔ auto: a stage reaped after the push records the landed commit instead of landing twice (0.588ms)
✔ auto: F refuses to squash a head that never contained the base (0.462292ms)
✔ auto: D rebases a head that never contained an unmoved base, then lands (1.484541ms)
✔ auto: three red GitHub gates escalate stuck_finding instead of alternating past the stall checks (1.807917ms)
✔ auto: a run set still growing between polls stays pending; a stable set gives the verdict (0.683209ms)
✔ auto: a stale completed run older than the dispatch bound cannot produce a verdict (0.3315ms)
✔ auto and shadow: a non-default harness is the review fleets' clis and the fix agent's cli (0.566958ms)
✔ a harness unsupported in land fails at stage one with a clear error (0.127334ms)
✔ each supported fix harness launches with its literal pinned model (2.541708ms)
✔ a review lane that cannot launch its cli ends needs_human, not a fix round (0.40925ms)
✔ codex without a login in the stage sandbox ends needs_human at preflight (0.748792ms)
✔ auto: a push-denied git credential fails preflight before any stage runs (0.134292ms)
✔ convergence: a clean gate proceeds, even past the budget or cap (0.860125ms)
✔ convergence: findings with rounds and budget left ask for a fix (0.093375ms)
✔ convergence: round cap (0.06775ms)
✔ convergence: the same finding id surviving 2 consecutive rounds (0.449292ms)
✔ convergence: finding count not decreasing for 2 rounds (0.196667ms)
✔ convergence: budget wins over every other rule (0.134333ms)
✔ convergence: refuses an empty history (1.591541ms)
✔ escalation: exact template when it fits (1.319708ms)
✔ escalation: a realistic UUID run URL drops the repo owner first (0.324458ms)
✔ escalation: over 150 bytes truncates the summary, keeps the ask and URL intact (0.455875ms)
✔ escalation: counts bytes, not code points, and never splits a character (0.17475ms)
✔ escalation: a URL that cannot fit is refused, never cut (0.428791ms)
✔ formatter guard: allows change files and finding files (0.386833ms)
✔ formatter guard: rejects files outside change ∪ findings and flags cargo fmt churn (0.142291ms)
✔ finding ids survive line moves and the verifier's "raised before" marker (0.952417ms)
✔ changelog: requires a new bullet under ## Unreleased (0.774167ms)
✔ isInside (0.342375ms)
✔ squash plan carries the trailers and is never marked pushed (0.28475ms)
✔ expandHome: only the literal $HOME/ prefix, against an absolute HOME (0.572208ms)
✔ clean run: A-adversarial → A-context → B → D → E (would dispatch) → F → landed (1.670667ms)
✔ E in shadow always reports would-dispatch and moves on to F, without closing a gate (0.177208ms)
✔ the gate unions all three lanes and feeds the fix round (0.154833ms)
✔ convergence stop: the same finding id surviving 2 consecutive rounds (0.256042ms)
✔ convergence stop: count not decreasing for 2 rounds (0.193125ms)
✔ convergence stop: round cap and wallclock budget (0.171791ms)
✔ formatter guard breach and rebase conflict end needs_human; a clean rebase regates (0.364667ms)
✔ superseded: the land ref moved (or was deleted) → cancelled, from any stage (0.232166ms)
✔ pure and fail-closed: no mutation, wrong result kinds and terminal states refused (0.265541ms)
✔ idempotent: the same state and result always give the same next state (0.167291ms)
✔ land-state.json round-trips and refuses other versions (2.870458ms)
✔ auto E: pending keeps the cursor at E, green moves to F, red feeds the fix loop (1.05975ms)
✔ auto E: a red gate still escalates on round cap (0.735666ms)
✔ auto F: pushed lands with the commit; moved and non_ff go back to D (0.526042ms)
✔ mode discipline: shadow outcomes refuse auto and vice versa (0.513084ms)
ℹ tests 85
ℹ suites 0
ℹ pass 85
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 511.386833
```

## Full shipped-source model-pin gate

Working directory: packages/sdk.

```sh
set -o pipefail; TMPDIR=/Users/khaliqgant/.cache/devin-harness node node_modules/vitest/vitest.mjs run tests/shipped-source-models.test.ts 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-claude-codex-model-gate.log
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/land-pinned-harnesses-20261102/packages/sdk

 ✓ tests/shipped-source-models.test.ts (2 tests) 243400ms
   ✓ first-party shipped source model pins > gives every TypeScript agent and LLM an explicit supported pair or a pinned named-agent declaration 243333ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  17:00:00
   Duration  244.09s (transform 143ms, setup 11ms, collect 412ms, tests 243.40s, environment 0ms, prepare 65ms)

```
