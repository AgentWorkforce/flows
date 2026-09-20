# `f.agent options.cwd`: accepted by the kernel, contained by the worker

Closes the accept-then-refuse split in flows#357. `f.agent({ cwd })` was
type-checked by the SDK, lowered into the step spec, passed `flows check`, and
then killed the run at dispatch:

```
FAILED [protocol_error] relayflowd could not complete the run request: invalid_spec: unknown field "cwd" at steps[0] — refusing to guess (fail closed)
```

The ticket offered three resolutions and called this one — accepting, then
refusing at dispatch — "the worst of the three". This PR takes the first: the
kernel accepts `cwd` on agent steps and the worker runs the CLI in that
directory, held inside the run's tree, as the ticket asked.

## The contract

`cwd` is a **run-root-relative** path. The run root is the working directory of
the process running the agent worker: the directory `flows run` was invoked
from, and the uploaded tree on the Cloud path (docs/CLOUD.md, "Code sync").

Relative-only is the substantive decision. An absolute host path is not a
portable declaration — it means nothing on another machine or inside a Cloud
upload — and it cannot be contained lexically, so allowing it would just move
the late refusal somewhere else. The ticket's own phrase, "still inside the
run's tree", is the rule this implements.

The contract is split in two, because they are two different facts:

- **The declaration** is lexical and filesystem-free, so `flows check`, the
  kernel's `validate()` and the worker all answer identically for the same
  spec. A path must be relative, non-empty, unpadded, NUL-free, URI-free, and
  free of empty / `.` / `..` components.
- **The target** is resolved only in the worker that spawns the CLI — the one
  process provably sharing the agent's filesystem. It must exist, be a
  directory, and have a symlink-free path inside the symlink-free run root.
  Re-checked at every dispatch even when a preflight passed, because the
  filesystem moves underneath a spec.

Refusals land at the earliest edge that can see them. A bad *declaration* is
refused by `flows check` and by the authored body before any run exists
(`report.runId` is `undefined` — nothing is started). A bad *target* completes
the step `worker_error` with the reason journaled, the same way a missing CLI
does, instead of spawning somewhere nobody established is inside the tree.

`cwd` is a declaration of where to start, not a sandbox — nothing stops a CLI
from writing outside it. Per-step scoping remains `permissions`, recorded and
not enforced (gate 8 / #442). This is stated in `docs/SURFACE.md`, as the
ticket requested, next to `AgentOptions`, along with why workspace surfaces are
not a directory selector.

`cwd` is **not supported with `transport: 'relay'`** and is refused rather than
forwarded: the agent runs on another host, where this worker can neither
resolve the directory nor hold it inside the run root. Failing closed beats
forwarding a string the contract promises to contain.

## Changes

**Kernel** (`kernel/relayflowd-core/src/spec.rs`)
- `"cwd"` added to `STEP_AGENT_FIELDS`; `StepKind::Agent` gains
  `cwd: Option<String>` with `#[serde(default, skip_serializing_if = ...)]`, so
  every pre-existing fixture stays byte-identical and the spec hash is unmoved.
- A **pre-serde shape check** refuses a non-string `cwd`. `Option<String>`
  reads an explicit `null` as absence, which would silently run the step in the
  default directory under a spec that declared otherwise.
- `validate()` refuses a non-run-root-relative value with a new
  `SpecError::InvalidAgentCwd { step, cwd }`, via `is_run_root_relative_path`
  layered on the existing `path_surface_identity` rule.

**SDK**
- `packages/sdk/src/agent-cwd.ts` (new) holds the whole policy: the lexical
  declaration rule, the relay refusal, the resolve-and-contain step, and the
  dispatch-time `agentStepCwd` that *reports* a refusal instead of throwing, so
  it lands on the step's completion rather than on the worker.
- `worker.ts` resolves before the lease and before spawning or scanning
  artifacts; `AgentWorkerOptions.runRoot` names the root a dispatch is measured
  against instead of assuming it.
- `communication/worker.ts` previously passed `spec.cwd ?? process.cwd()`
  straight to the PTY spawn — unresolved and unchecked. It now resolves through
  the same module against the same `runRoot`, so the two worker paths cannot
  disagree about where the run root is.
- `compile.ts`: `cwd` added to `kernelStepToAuthoring`, repairing inverse-mapping
  data loss that silently dropped the field on the kernel→authoring round trip.
- `validate.ts` and `authored-worker-step.ts` raise the same refusal at
  `flows check` and authoring time.

### Cross-language whitespace parity

Rust's `char::is_whitespace` is Unicode `White_Space` exactly; JavaScript's
`\s` is `White_Space` without U+0085 and with U+FEFF. Left alone, a path padded
with either character would pass `flows check` and be refused by the kernel —
exactly the split this PR closes. Each side names the other's missing
character, so both refuse `White_Space ∪ {U+FEFF}`. Both dialects are tested
against the shared corpus.

## Tests

- `testdata/agent-cwd-cases.json` — 24 shared declaration cases, consumed by
  both `kernel/relayflowd-core/tests/spec_parity.rs` (5 new tests) and
  `packages/sdk/tests/agent-cwd.test.ts` (53 tests), so the two dialects are
  proven to answer identically rather than assumed to.
- `testdata/agent-cwd.flow.yaml` + canonical JSON + sha256 pin byte and hash
  agreement across the boundary.
- `packages/sdk/tests/agent-cwd.test.ts` also covers `flows check` end to end
  on a real project — the ticket's "`flows check` passes so nothing catches it
  before the run" is now a test.
- `packages/sdk/tests/agent-cwd-live.test.ts` (new, 4 tests) drives the real
  daemon through `flows run --local-agent` with **two agents in two nested
  checkouts**, asserting each CLI's reported `process.cwd()`, that artifacts are
  relative to the agent's directory, that an `artifact_exists` gate resolves
  against it, and that neither refusal path runs anything anywhere.

### Mutation-verified

The live test was proven to catch the original bug, not merely to pass
alongside the fix. Deleting `"cwd",` from `STEP_AGENT_FIELDS` and rebuilding
the daemon turns it red, reproducing the ticket's error character for
character:

```
FAILED [protocol_error] relayflowd could not complete the run request: invalid_spec: unknown field "cwd" at steps[0] — refusing to guess (fail closed)
```

Under the same mutation Rust `spec_parity` goes `15 passed` → `13 passed; 2 failed`.
Restoring the line returns both to green.

## Results

```
kernel:  sh ops/cargo.sh test --workspace   265 passed; 0 failed
sdk:     npx vitest run tests/agent-cwd.test.ts tests/agent-cwd-live.test.ts tests/communication-*.test.ts
         Test Files 11 passed (11)   Tests 110 passed (110)
sdk:     npx vitest run (full)
         Test Files  7 failed | 149 passed | 3 skipped (159)
         Tests      40 failed | 2413 passed | 25 skipped (2478)
typecheck: SURFACE OK · SDK OK · SDK TESTS OK · SDK TYPE-TESTS OK
```

The 40 failures are **pre-existing and environmental**, not caused by this
change. Proven by stashing the entire working tree
(`git stash push --include-untracked`), rebuilding, and re-running: identical
files and identical per-file counts — stuck-run-triage 22, live-kernel 8,
webhook-live 6, provider-trigger-executor 3, mcp 1,
communication-mixed-resume 1, authored-node-runtime 1. Those files hard-code
`kernel/target/{debug,release}/relayflowd`, which this toolchain does not use;
the live tests added here resolve the binary through `ops/cargo.sh metadata`
and run.

`packages/schema/flows.schema.json` was regenerated with
`node scripts/generate-json-schema.mjs`, never hand-edited; the diff is exactly
the two new `cwd` descriptions.

## Deliberate behaviour change

Absolute `cwd` values that SDK-only paths previously tolerated are now refused.
Two test files declared one; in both, the declaration was inert decoration that
nothing ever resolved (no worker is attached to those fake kernels), so both
were repaired to the run-root-relative form. No flow that ran before can stop
running: a spec carrying `cwd` could not reach a run at all.

## Follow-up, deliberately not in this PR

`transport` has the same inverse-mapping gap in `kernelStepToAuthoring` that
`cwd` had. It is a separate defect on a separate field and is left for its own
change rather than folded in here.

## Not run

`clippy` and `rustfmt` are not installed for this toolchain
(`error: 'cargo-clippy' is not installed`).
