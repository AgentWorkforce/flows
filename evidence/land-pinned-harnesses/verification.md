# Land model-pin fix-forward verification

Land supports Claude and Codex; Codex remains the default. Grok and Devin stay
reserved configuration names and refuse before review or fix work. There is no
new SDK/Surface capability API and no additional release dependency in this PR.

The land-specific model waiver is removed. Fix calls use literal supported
pairs: Claude/claude-sonnet-5 and Codex/gpt-5.6-sol. parseLandConfig refuses
configured fixLoop.model values as not supported yet. The needs_human test
asserts the complete authentication error, including the instruction to deliver
FLOW_OPENAI_API_KEY to flow runs. No land deployment was changed.

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
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness npm run typecheck --prefix examples/land && TMPDIR=/Users/khaliqgant/.cache/devin-harness npm test --prefix examples/land; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-claude-codex-only-final.log
```

```text

> typecheck
> tsc -p tsconfig.json


> test
> node --experimental-strip-types --test tests/*.test.ts

✔ defaults: mergePolicy is shadow, placeholders are the spec proposals (0.921917ms)
✔ a full relay-desktop shaped config round-trips (0.174333ms)
✔ model overrides are explicitly unsupported for every harness (0.278208ms)
✔ refusals: unknown keys, bad enums, unsafe paths, out-of-range numbers (0.275083ms)
✔ JSON schema matches the runtime validator: keys, required, enums and defaults (0.123583ms)
✔ every PLACEHOLDER default names its open question (0.369125ms)
✔ clean shadow run: one hosted run per stage, E would dispatch, squash plan written, never pushed (6.041333ms)
✔ intent isolation: only context review is given intentFile; the adversarial fleet never sees it (0.712541ms)
✔ fix loop: the fixup head is carried between runs in land.bundle, then the gate reruns clean (1.216542ms)
✔ non-convergence: a finding surviving 2 rounds ends needs_human with a ≤150-byte ask (1.514542ms)
✔ formatter guard: a fix round touching files outside change ∪ findings ends needs_human (0.384958ms)
✔ changelog required with no new Unreleased bullet becomes a finding for the fix loop (0.666125ms)
✔ stage D: a moved base rebases and regates; a conflict ends needs_human (0.792333ms)
✔ superseded: the land ref moved → cancelled before any work in that run (0.119ms)
✔ idempotent cursor: a retried stage whose state write landed is a no-op; a reaped one reruns (0.55225ms)
✔ stage E in shadow: records what it would dispatch, launches nothing, moves on to F (0.42ms)
✔ the removed githubGateInShadow flag is refused as an unknown key, before any work (0.130667ms)
✔ refusals: no state outside A-adversarial, approval mode, state or intent inside the checkout, wrong run (0.419125ms)
✔ runId: an explicit Cloud id names the Land-Run trailer and every completion detail, not the stateDir path (0.384334ms)
✔ runId: absent, it falls back to the stateDir segment for local use (0.41775ms)
✔ runId: a malformed id, or a stateDir segment that is not one, is refused before any work (0.137209ms)
✔ runId: a stage invoked with another run id is refused and leaves the state alone (1.049667ms)
✔ $HOME paths: expanded from the run's own HOME, read once per run through a journaled step (1.374542ms)
✔ $HOME paths: a trailing slash on HOME is normalized (0.105166ms)
✔ $HOME paths: absolute paths never read HOME (0.311833ms)
✔ $HOME paths: refused when HOME is unset, relative, or unsafe (0.141209ms)
✔ $HOME paths: only the exact $HOME/ prefix; no other variable, form or .. segment (0.1975ms)
✔ $HOME paths: the outside-checkout check runs on the expanded path (0.074583ms)
✔ absolute paths: a . or .. in any segment is refused, including the first (/../x) (0.145917ms)
✔ the base fetch deepens a shallow checkout and names only the base refspec (198.126083ms)
✔ auto: dispatch overruns, the next E awaits the pushed snapshot, F squash-pushes and lands (1.679084ms)
✔ auto: a gate that finishes inside the dispatch window applies its verdict in the same run (0.477333ms)
✔ auto: red GitHub gate goes to the next fix round (0.797417ms)
✔ auto: a failed dispatched run is red to the fix loop (0.950125ms)
✔ auto: still-pending dispatched runs keep E as the cursor across stage runs (0.90975ms)
✔ auto: F goes back to D on non-fast-forward (0.529208ms)
✔ auto: a moved base at F goes back to D and regates (0.985625ms)
✔ auto: a non-FF, non-permission push failure ends needs_human (0.48525ms)
✔ auto and shadow: the land harness is the review fleets' clis and the fix agent's cli (0.629458ms)
✔ auto: a stage reaped after the push records the landed commit instead of landing twice (0.400292ms)
✔ auto: F refuses to squash a head that never contained the base (0.371416ms)
✔ auto: D rebases a head that never contained an unmoved base, then lands (1.345458ms)
✔ auto: three red GitHub gates escalate stuck_finding instead of alternating past the stall checks (1.092833ms)
✔ auto: a run set still growing between polls stays pending; a stable set gives the verdict (0.574958ms)
✔ auto: a stale completed run older than the dispatch bound cannot produce a verdict (0.302916ms)
✔ auto and shadow: a non-default harness is the review fleets' clis and the fix agent's cli (0.483208ms)
✔ a harness unsupported in land fails at stage one with a clear error (0.107875ms)
✔ each supported fix harness launches with its literal pinned model (1.228125ms)
✔ a review lane that cannot launch its cli ends needs_human, not a fix round (0.131459ms)
✔ codex without a login in the stage sandbox ends needs_human at preflight (0.379334ms)
✔ auto: a push-denied git credential fails preflight before any stage runs (0.101041ms)
✔ convergence: a clean gate proceeds, even past the budget or cap (1.616583ms)
✔ convergence: findings with rounds and budget left ask for a fix (0.199166ms)
✔ convergence: round cap (0.136458ms)
✔ convergence: the same finding id surviving 2 consecutive rounds (0.262041ms)
✔ convergence: finding count not decreasing for 2 rounds (0.151959ms)
✔ convergence: budget wins over every other rule (0.114375ms)
✔ convergence: refuses an empty history (0.41975ms)
✔ escalation: exact template when it fits (0.570625ms)
✔ escalation: a realistic UUID run URL drops the repo owner first (0.157166ms)
✔ escalation: over 150 bytes truncates the summary, keeps the ask and URL intact (0.435208ms)
✔ escalation: counts bytes, not code points, and never splits a character (0.099542ms)
✔ escalation: a URL that cannot fit is refused, never cut (0.087542ms)
✔ formatter guard: allows change files and finding files (0.136833ms)
✔ formatter guard: rejects files outside change ∪ findings and flags cargo fmt churn (0.083416ms)
✔ finding ids survive line moves and the verifier's "raised before" marker (0.257334ms)
✔ changelog: requires a new bullet under ## Unreleased (0.190833ms)
✔ isInside (0.072125ms)
✔ squash plan carries the trailers and is never marked pushed (0.113459ms)
✔ expandHome: only the literal $HOME/ prefix, against an absolute HOME (0.205416ms)
✔ clean run: A-adversarial → A-context → B → D → E (would dispatch) → F → landed (1.542917ms)
✔ E in shadow always reports would-dispatch and moves on to F, without closing a gate (0.292125ms)
✔ the gate unions all three lanes and feeds the fix round (0.1975ms)
✔ convergence stop: the same finding id surviving 2 consecutive rounds (0.273583ms)
✔ convergence stop: count not decreasing for 2 rounds (0.214166ms)
✔ convergence stop: round cap and wallclock budget (1.179625ms)
✔ formatter guard breach and rebase conflict end needs_human; a clean rebase regates (0.765542ms)
✔ superseded: the land ref moved (or was deleted) → cancelled, from any stage (0.568375ms)
✔ pure and fail-closed: no mutation, wrong result kinds and terminal states refused (0.735208ms)
✔ idempotent: the same state and result always give the same next state (0.432541ms)
✔ land-state.json round-trips and refuses other versions (0.659292ms)
✔ auto E: pending keeps the cursor at E, green moves to F, red feeds the fix loop (0.370541ms)
✔ auto E: a red gate still escalates on round cap (0.176583ms)
✔ auto F: pushed lands with the commit; moved and non_ff go back to D (0.145875ms)
✔ mode discipline: shadow outcomes refuse auto and vice versa (0.20075ms)
ℹ tests 85
ℹ suites 0
ℹ pass 85
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 375.197833
```

## Full shipped-source model-pin gate

Working directory: packages/sdk. Captured at `23a1bb2a`; the subsequent changes
only clarify documentation and tighten the credential-hint unit assertion.
The shipped source and model gate are unchanged.

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
