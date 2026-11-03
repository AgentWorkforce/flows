# Land fix-forward verification

The land-specific dynamic-model waiver is removed. Each supported fix branch
uses a literal CLI/model pair; configured model overrides are refused. The
normal supported-pair table now includes the native Devin gpt-5.6-sol pair.
Codex remains the default. Devin requires native-adapter metadata from the
executing SDK and a supported separate CLI for review fleets.

The metadata is introduced by this follow-up, so enabling this guarded land
lane requires a subsequent SDK/Surface release. Published 2.0.57 contains the
native Devin adapter but predates the metadata. No land deployment is changed.

## Reproducing on another checkout

The records below preserve the literal commands and raw captured output from
this run, as required by the repository evidence policy. Their absolute paths
identify the original run; they are not prerequisites for another machine.
Use Node 22, Bun 1.4.x, a built local Surface/SDK and a matching local kernel.
Set `RELAYFLOWD_BIN` to the kernel executable on your machine. From the repo root:

```sh
export TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/relayflows-land-proof"
mkdir -p "$TMPDIR"
: "${RELAYFLOWD_BIN:?Set RELAYFLOWD_BIN to your relayflowd executable}"
(cd examples/land && npm run typecheck && npm test)
(cd packages/sdk && node node_modules/vitest/vitest.mjs run tests/authored-flow.test.ts tests/adapters/registry.test.ts tests/shipped-source-models.test.ts && npm run typecheck && npm run typecheck:tests)
(cd packages/sdk && node node_modules/vitest/vitest.mjs run tests/authored-node-runtime.test.ts -t 'advertises native direct-agent adapters inside')
(cd packages/surface && npm run typecheck:regressions && npm run check:docs)
```

## Land tests and types

Working directory: `examples/land`.

```sh
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness npm run typecheck && TMPDIR=/Users/khaliqgant/.cache/devin-harness npm test; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-followup-tests-rebased.log
```

```text

> typecheck
> tsc -p tsconfig.json


> test
> node --experimental-strip-types --test tests/*.test.ts

✔ defaults: mergePolicy is shadow, placeholders are the spec proposals (0.952792ms)
✔ a full relay-desktop shaped config round-trips (2.766875ms)
✔ model overrides are explicitly unsupported for every harness (0.842333ms)
✔ refusals: unknown keys, bad enums, unsafe paths, out-of-range numbers (0.943416ms)
✔ JSON schema matches the runtime validator: keys, required, enums and defaults (0.155458ms)
✔ every PLACEHOLDER default names its open question (0.3825ms)
✔ clean shadow run: one hosted run per stage, E would dispatch, squash plan written, never pushed (5.40575ms)
✔ intent isolation: only context review is given intentFile; the adversarial fleet never sees it (2.14225ms)
✔ fix loop: the fixup head is carried between runs in land.bundle, then the gate reruns clean (3.794417ms)
✔ non-convergence: a finding surviving 2 rounds ends needs_human with a ≤150-byte ask (2.660584ms)
✔ formatter guard: a fix round touching files outside change ∪ findings ends needs_human (0.976875ms)
✔ changelog required with no new Unreleased bullet becomes a finding for the fix loop (0.909167ms)
✔ stage D: a moved base rebases and regates; a conflict ends needs_human (0.8925ms)
✔ superseded: the land ref moved → cancelled before any work in that run (0.124334ms)
✔ idempotent cursor: a retried stage whose state write landed is a no-op; a reaped one reruns (0.538958ms)
✔ stage E in shadow: records what it would dispatch, launches nothing, moves on to F (0.422375ms)
✔ the removed githubGateInShadow flag is refused as an unknown key, before any work (0.131875ms)
✔ refusals: no state outside A-adversarial, approval mode, state or intent inside the checkout, wrong run (0.408542ms)
✔ runId: an explicit Cloud id names the Land-Run trailer and every completion detail, not the stateDir path (0.383ms)
✔ runId: absent, it falls back to the stateDir segment for local use (0.405625ms)
✔ runId: a malformed id, or a stateDir segment that is not one, is refused before any work (0.123708ms)
✔ runId: a stage invoked with another run id is refused and leaves the state alone (0.135833ms)
✔ $HOME paths: expanded from the run's own HOME, read once per run through a journaled step (0.857542ms)
✔ $HOME paths: a trailing slash on HOME is normalized (0.084541ms)
✔ $HOME paths: absolute paths never read HOME (0.287542ms)
✔ $HOME paths: refused when HOME is unset, relative, or unsafe (0.133542ms)
✔ $HOME paths: only the exact $HOME/ prefix; no other variable, form or .. segment (0.193625ms)
✔ $HOME paths: the outside-checkout check runs on the expanded path (0.069834ms)
✔ absolute paths: a . or .. in any segment is refused, including the first (/../x) (0.100416ms)
✔ the base fetch deepens a shallow checkout and names only the base refspec (288.000917ms)
✔ auto: dispatch overruns, the next E awaits the pushed snapshot, F squash-pushes and lands (2.604334ms)
✔ auto: a gate that finishes inside the dispatch window applies its verdict in the same run (0.775834ms)
✔ auto: red GitHub gate goes to the next fix round (2.481542ms)
✔ auto: a failed dispatched run is red to the fix loop (2.089833ms)
✔ auto: still-pending dispatched runs keep E as the cursor across stage runs (1.92125ms)
✔ auto: F goes back to D on non-fast-forward (0.676083ms)
✔ auto: a moved base at F goes back to D and regates (2.014084ms)
✔ auto: a non-FF, non-permission push failure ends needs_human (0.940542ms)
✔ auto and shadow: the land harness is the review fleets' clis and the fix agent's cli (1.331167ms)
✔ auto: a stage reaped after the push records the landed commit instead of landing twice (2.368708ms)
✔ auto: F refuses to squash a head that never contained the base (1.392084ms)
✔ auto: D rebases a head that never contained an unmoved base, then lands (2.482125ms)
✔ auto: three red GitHub gates escalate stuck_finding instead of alternating past the stall checks (2.144208ms)
✔ auto: a run set still growing between polls stays pending; a stable set gives the verdict (0.899542ms)
✔ auto: a stale completed run older than the dispatch bound cannot produce a verdict (0.51775ms)
✔ auto and shadow: a non-default harness is the review fleets' clis and the fix agent's cli (0.64975ms)
✔ a harness without a worker adapter fails at stage one with a clear error (0.124209ms)
✔ Devin refuses missing/older runtime metadata before review or fix work (0.210375ms)
✔ each supported fix harness launches with its literal pinned model (2.648917ms)
✔ Devin refuses an older or unknown child flows runtime before review work (0.768917ms)
✔ a review lane that cannot launch its cli ends needs_human, not a fix round (0.235125ms)
✔ codex without a login in the stage sandbox ends needs_human at preflight (0.372333ms)
✔ auto: a push-denied git credential fails preflight before any stage runs (0.958041ms)
✔ convergence: a clean gate proceeds, even past the budget or cap (0.777417ms)
✔ convergence: findings with rounds and budget left ask for a fix (0.086375ms)
✔ convergence: round cap (0.059958ms)
✔ convergence: the same finding id surviving 2 consecutive rounds (0.106792ms)
✔ convergence: finding count not decreasing for 2 rounds (0.06275ms)
✔ convergence: budget wins over every other rule (0.064834ms)
✔ convergence: refuses an empty history (0.154583ms)
✔ escalation: exact template when it fits (0.110708ms)
✔ escalation: a realistic UUID run URL drops the repo owner first (0.061292ms)
✔ escalation: over 150 bytes truncates the summary, keeps the ask and URL intact (0.12725ms)
✔ escalation: counts bytes, not code points, and never splits a character (0.06375ms)
✔ escalation: a URL that cannot fit is refused, never cut (0.05875ms)
✔ formatter guard: allows change files and finding files (0.081833ms)
✔ formatter guard: rejects files outside change ∪ findings and flags cargo fmt churn (0.069708ms)
✔ finding ids survive line moves and the verifier's "raised before" marker (0.220917ms)
✔ changelog: requires a new bullet under ## Unreleased (0.206958ms)
✔ isInside (0.066833ms)
✔ squash plan carries the trailers and is never marked pushed (0.0875ms)
✔ expandHome: only the literal $HOME/ prefix, against an absolute HOME (0.160584ms)
✔ clean run: A-adversarial → A-context → B → D → E (would dispatch) → F → landed (1.162083ms)
✔ E in shadow always reports would-dispatch and moves on to F, without closing a gate (0.147916ms)
✔ the gate unions all three lanes and feeds the fix round (0.154083ms)
✔ convergence stop: the same finding id surviving 2 consecutive rounds (0.2435ms)
✔ convergence stop: count not decreasing for 2 rounds (0.194459ms)
✔ convergence stop: round cap and wallclock budget (0.171459ms)
✔ formatter guard breach and rebase conflict end needs_human; a clean rebase regates (0.268875ms)
✔ superseded: the land ref moved (or was deleted) → cancelled, from any stage (0.212375ms)
✔ pure and fail-closed: no mutation, wrong result kinds and terminal states refused (0.259708ms)
✔ idempotent: the same state and result always give the same next state (0.15525ms)
✔ land-state.json round-trips and refuses other versions (0.266916ms)
✔ auto E: pending keeps the cursor at E, green moves to F, red feeds the fix loop (0.134333ms)
✔ auto E: a red gate still escalates on round cap (0.131375ms)
✔ auto F: pushed lands with the commit; moved and non_ff go back to D (0.12775ms)
✔ mode discipline: shadow outcomes refuse auto and vice versa (0.154709ms)
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 495.924375
```

## SDK executor, registry, full model-pin gate and types

Working directory: `packages/sdk`.

```sh
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness node node_modules/vitest/vitest.mjs run tests/authored-flow.test.ts tests/adapters/registry.test.ts tests/shipped-source-models.test.ts && npm run typecheck && npm run typecheck:tests; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-followup-sdk-final.log
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/land-pinned-harnesses-20261102/packages/sdk

 ✓ tests/adapters/registry.test.ts (4 tests) 2ms
 ✓ tests/authored-flow.test.ts (39 tests) 748ms
 ✓ tests/shipped-source-models.test.ts (2 tests) 162698ms
   ✓ first-party shipped source model pins > gives every TypeScript agent and LLM an explicit supported pair or a pinned named-agent declaration 162624ms

 Test Files  3 passed (3)
      Tests  45 passed (45)
   Start at  16:33:31
   Duration  163.31s (transform 1.02s, setup 28ms, collect 2.06s, tests 163.45s, environment 0ms, prepare 157ms)


> @relayflows/sdk@2.0.57 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.57 typecheck:tests
> tsc -p tsconfig.tests.json

```

## Real compiled CLI through embedded Node

Working directory: `packages/sdk`.

```sh
set -o pipefail; PATH=/Users/khaliqgant/.nvm/versions/node/v22.22.2/bin:$PATH TMPDIR=/Users/khaliqgant/.cache/devin-harness RELAYFLOWD_BIN=/Volumes/T7/Projects/AgentWorkforce/artifacts/land-pinned-harnesses-20261102/package/bin/relayflowd node node_modules/vitest/vitest.mjs run tests/authored-node-runtime.test.ts -t 'advertises native direct-agent adapters inside' 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-embedded-capability.log
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/land-pinned-harnesses-20261102/packages/sdk

 ✓ tests/authored-node-runtime.test.ts (23 tests | 22 skipped) 3898ms
   ✓ Bun 1.4.x standalone → native Node authored lifecycle > advertises native direct-agent adapters inside the embedded Node runner 2893ms

 Test Files  1 passed (1)
      Tests  1 passed | 22 skipped (23)
   Start at  16:46:34
   Duration  5.71s (transform 758ms, setup 15ms, collect 1.50s, tests 3.90s, environment 0ms, prepare 56ms)

```

## Surface regressions and generated documentation

Working directory: `packages/surface`.

```sh
set -o pipefail; { npm run typecheck:regressions && npm run check:docs; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-surface-final.log
```

```text

> @relayflows/surface@2.0.57 typecheck:regressions
> tsc -p ../../regressions/tsconfig.json && tsc -p tsconfig.test.json && node scripts/check-generated-helpers.mjs

HELPERS_GENERATED_OK airtable.ts, asana.ts, azure-blob.ts, box.ts, calendly.ts, clickup.ts, clients.ts, cloudflare.ts, confluence.ts, daytona.ts, docker-hub.ts, dropbox.ts, fathom.ts, gcp.ts, gcs.ts, github.ts, gitlab.ts, gmail.ts, google-calendar.ts, google-drive.ts, granola.ts, hubspot.ts, index.ts, intercom.ts, jira.ts, linear.ts, mailgun.ts, mixpanel.ts, neon.ts, notion.ts, onedrive.ts, pipedrive.ts, postgres.ts, posthog.ts, providers.ts, ramp.ts, recall.ts, reddit.ts, redis.ts, s3.ts, salesforce.ts, segment.ts, sendgrid.ts, sharepoint.ts, shopify.ts, shortcut.ts, slack.ts, stripe.ts, teams.ts, telegram.ts, webhook-server.ts, x.ts, zendesk.ts

> @relayflows/surface@2.0.57 check:docs
> node ../../scripts/check-authoring-reference.mjs && node --test ../../scripts/authoring-reference.test.mjs

AUTHORING_REFERENCE_OK
✔ extracts overloads in order and preserves lease JSDoc byte-for-byte (8.219708ms)
✔ walks union members even when not re-exported, including nested unions (1.404125ms)
✔ CLI literals refuse unresolved options with command and identifier (2.322583ms)
✔ CLI literals resolve imports, spreads, String and templates but refuse dynamic defaults (10.264667ms)
✔ run documents every exported overload and the lease comment (0.558708ms)
✔ done documents all three distinct completion vocabularies (1.758917ms)
✔ human returns Step<boolean> (0.085708ms)
✔ all helper namespaces and mcp are discoverable (0.802959ms)
✔ FlowHeader includes every field and its declaration (0.334083ms)
✔ AgentOptions includes every field and its declaration (0.833083ms)
✔ all named gate variants and both gate overloads are documented (0.634ms)
✔ CLI includes every declared verb, subcommand and literal flag (2.6005ms)
✔ lease prose agrees with type, kernel default and compiler ceiling (5.352625ms)
✔ checker accepts exact docs, rejects drift or missing docs, and accepts restoration (4220.564167ms)
✔ every relative link in shipped surface markdown resolves inside the packed package (1046.522542ms)
✔ every exported surface type the reference mentions is declared in it (44.419125ms)
✔ trigger and helper entry points are documented (2.89675ms)
✔ in-package re-exports are declared, never pointed at by a source path (0.40925ms)
✔ every provider trigger reachable through star re-exports is documented (18.636375ms)
✔ every function exported from the package root has its signature in the reference (1.196708ms)
✔ every type a rendered declaration names is declared, imported or a TypeScript global (70.26275ms)
✔ declares every public type, including type-only exports no signature names (11.707333ms)
✔ claims only what it declares: dependency types are named, links name their version skew (0.468417ms)
✔ declares every package-root export, including declarations a star-exported barrel owns (17.534292ms)
✔ a copied implementation imports every free function it calls (2.064667ms)
✔ CLI reference lists the root-level flags runCli handles before verbs (0.122458ms)
✔ a const assertion names no type (0.151917ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5710.952458
```

## Test typecheck after adding embedded regression

Working directory: `packages/sdk`.

```sh
set -o pipefail; npm run typecheck:tests 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/land-sdk-test-types-final.log
```

```text

> @relayflows/sdk@2.0.57 typecheck:tests
> tsc -p tsconfig.tests.json

```

The embedded regression builds this follow-up's standalone CLI and uses the
verified Surface execution envelope already used by the Cloud runtime fixture.
It invokes the real published 2.0.57 Darwin kernel under Node 22.22.2. It checks
immutable native-adapter metadata, not provider installation/authentication.

A direct bare-Surface manual probe was refused by both the released CLI and the
local standalone before capability code ran. That setup does not use the Cloud
execution envelope and is not claimed as a successful integration run here.
