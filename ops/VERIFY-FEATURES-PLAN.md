# VERIFY-FEATURES — every feature in flows verifiable, then autonomous merge

Directive from Khaliq, 2026-09-14. Goal state:

> A PR merges without a human when unit tests, integration tests, and **flow
> tests** are all green at its head. A flow test is a `.flow.ts` that uses an
> agent to exercise a feature end to end, with deterministic gates judging the
> result. Every feature and piece of functionality in this repo is mapped to
> the tests that prove it, so a break is known before it lands — the same shape
> as `relay`'s `verify-features` (manifest + audit + tiered procedures +
> `checks.jsonl` / `verdict.json`).

This file is the ordered work list. Each drive tick takes the **first work
package whose `blocked-by` are all merged**, or fixes an open PR from an
earlier package if review is waiting. Never two packages in one tick.

## Where we started (2026-09-14, measured)

- `main` has no branch protection and no rulesets; no check is required.
  PR #383 merged having run only `review` + `guard` — every test workflow is
  path-filtered, so a diff outside `kernel/`, `packages/sdk/**`,
  `packages/surface/**`, `regressions/**`, `testdata/**` runs zero tests.
- Unit: SDK 101 test files / 120 src; kernel 240 `#[test]`s incl.
  `crash_resume`; **surface 5 test files / 70 src**; ts-plugin 1;
  `create-flow` and `relayflows` wrappers 0.
- Integration: `live-kernel`, `daemon-lifecycle-live`, `yaml-local-agent-live`,
  `webhook-live`, `real-cli-adapters` exist, but CI sets
  `RELAYFLOWS_ALLOW_ANALYZER_SKIP=1` and never sets
  `RELAYFLOWS_REAL_CLI_ADAPTERS`. CI has never proved an agent step against a
  real model.
- Flow tests: `regressions/` is dormant (typecheck only); `examples/` gallery
  1/3 passing by hand; nothing in `workflows/` runs in CI. Zero flows run in CI.
- No feature manifest, no surface audit, no change→feature mapping, no
  coverage measurement (no vitest coverage provider, no `cargo llvm-cov`).
- Model access in CI: GitHub runners have no `claude`/`codex`/`grok`. The
  review swarm gets a model by placing itself in Agent Relay Cloud
  (`agent-relay cloud run workflows/review-swarm.yaml --sync-code`).

## Tiers (pin these words; SKIP is never PASS)

| Tier | Name | Environment | Proves |
| --- | --- | --- | --- |
| 0 | unit | vitest / cargo, no I/O | one module's contract |
| 1 | integration | real `relayflowd` + deterministic wrapper CLIs from `testdata/preflight/`, no model | components compose |
| 2 | flow test | `flows run --local-agent` against the real kernel + a real agent CLI + pinned model; gates on journal facts | the feature works for a user |
| 3 | cloud flow test | tier 2 placed via `agent-relay cloud run` | cloud-only features (deploy/bucket, `run --cloud`, webhook admission) |

Every check records `pass` / `fail` / `skip` + reason in `checks.jsonl`;
`verdict.json` is the only authoritative result. An agent's prose never
greens a test — only a deterministic gate does.

## Work packages, in order

Each has a runnable definition of done. Quote the DoD into `ops/NEXT.md`;
paste literal command output in the PR (AGENTS.md "Evidence is captured").

### WP-V1 — surface `expect(kind)`: declared-failure assertion
- **Why first:** `regressions/README.md` gap #1. Negative flow tests ("this
  refuses with `model_unavailable`") cannot be written without it, and every
  refusal path in the manifest needs one.
- **Scope:** `packages/surface/src/step.ts` (+ types), lowering in
  `packages/sdk/src/named-gate-lowering.ts` / `named-gates.ts`,
  `docs/SURFACE.md` §2 entry. A step may declare
  `.expect({ kind: '<failure_kind>' })`; the run passes iff the step fails
  with exactly that declared kind and fails otherwise.
- **DoD:** `cd packages/surface && bun run test` and `cd packages/sdk && npm test`
  pass with new tests covering: matching kind passes; wrong kind fails; step
  that succeeds fails the expectation. One regression pair in `regressions/`
  rewritten to use it, typechecking under `bun run typecheck:regressions`.
- **blocked-by:** none.

### WP-V2 — feature manifest v1 + surface audit
- **Scope:** `.agentworkforce/features/manifest.yaml`,
  `.agentworkforce/features/verify/procedures.md`,
  `scripts/audit-feature-manifest.mjs`, `scripts/audit-feature-manifest.test.mjs`.
- **Manifest entry shape:** `id`, `name`, `category`, `criticality`
  (`critical|hot|standard`), `location` (globs), `verify_tier` (0–3), and
  `verify: { unit: [...], integration: [...], flow: [...] }` listing test
  files / flow ids, or `unverified: <reason>`.
- **Categories to enumerate (derive, do not guess):** CLI commands from the
  `USAGE` block in `packages/sdk/src/cli.ts` (`add build deploy run[yaml|ts|digest|cloud|local-agent|reuse] check[watch|json] serve-webhook tick resume replay observer hn-monitor`);
  surface verbs from `packages/surface/src/context.ts` and `step.ts`
  (`f.run`, three `f.llm` forms, `f.agent`, named + predicate `.gate`,
  `.expect`, `f.done`, `f.cloud.*`, `f.memory.*`, slack); YAML dialect + every
  helper in `packages/surface/src/helpers/index.ts` + `triggers/`; kernel
  behaviours (journal, resume, leases, durable timers, streams, hello ladder
  a/b/c, budget); adapters (`claude`, `codex`, `wrapper`, headless per
  `packages/sdk/src/adapters/`); plugins/`flows add`; webhook receiver
  (auth, rate limit, provider-shape, admission); bundle/digest; MCP; observer
  link; daemon lifecycle.
- **Audit:** derives the surface from `flows --help`, the exported
  `FlowContext` type, `helpers/index.ts`, `triggers/`, and diffs against the
  manifest. Exit `0` clean, `1` drift, `2` audit could not run (never read as
  clean). Fails on any feature with no `verify` entry and no `unverified`.
- **DoD:** `node scripts/audit-feature-manifest.mjs` exits 0 on the branch;
  `node --test scripts/audit-feature-manifest.test.mjs` passes and includes a
  case where a command is added to USAGE and the audit reports drift.
- **blocked-by:** WP-V1 (so `.expect` is in the surface the audit derives).

### WP-V3 — flow-test harness + first critical flows
- **Scope:** `flow-tests/<feature-id>.flow.ts` (v2 dialect), `scripts/flow-tests.mjs`,
  `scripts/flow-tests.test.mjs`, `flow-tests/README.md`.
- **Runner:** reads the manifest; `--feature <id>...` or `--all`; runs each
  flow via `flows run --local-agent --json --data-dir <tmp>`; writes
  `.workflow-artifacts/flow-tests/checks.jsonl` and `verdict.json`
  (`pass|fail|skip` + reason per feature; overall = no `fail`, and no `skip`
  on a `critical` feature). Zero retries. Per-flow budget cap and timeout.
- **First flows (all `critical`):** hello ladder a (deterministic), b (llm +
  gate), c (agent); kill -9 mid-run then `flows resume` completes only
  unfinished work with exact budget; `flows check` refuses a missing /
  unauthenticated CLI (uses WP-V1 `.expect`); `serve-webhook` rejects a bad
  signature and admits a good one; budget cap parks the run with
  `completionReason` set.
- **DoD:** `node scripts/flow-tests.mjs --all` on an authenticated host
  writes a `verdict.json` with every listed feature `pass`; the runner's own
  tests pass; `regressions/` pairs run under the same runner with red/green
  semantics (red passes while the bug is open, green fails).
- **blocked-by:** WP-V1, WP-V2.

### WP-V4 — CI runs every tier on every PR
- **Scope:** `.github/workflows/tests.yml` (new umbrella: kernel, SDK,
  surface, ts-plugin, schema, `create-flow`/`relayflows` smoke — no path
  filters), `.github/workflows/flow-tests.yml` (places `workflows/flow-tests.yaml`
  in Agent Relay Cloud exactly like `review-swarm.yml`, waits, posts
  `verdict.json` to the PR, fails the job on any `fail` or critical `skip`),
  and in that placed job `RELAYFLOWS_REAL_CLI_ADAPTERS=1` with
  `RELAYFLOWS_ALLOW_ANALYZER_SKIP` unset so the live integration tests gate.
- **Selection:** changed files → manifest `location` globs → feature ids →
  their flows; `critical` always; `--all` on `push: main` and in the merge
  queue. The PR gets one sticky comment: "touches X, Y; flow tests A, B: PASS".
- **DoD:** on the PR that adds it, both workflows run and are green; the
  posted comment names the features the PR touched.
- **blocked-by:** WP-V3.
- **Human step (Khaliq, cannot be done from a sandbox):** ruleset on `main`
  requiring `tests`, `flow-tests`, `linux-x64-artifact`, `packed-consumer`,
  `review`, `guard`, `npm` at the head sha; enable merge queue. Write
  `ops/NEEDS_HUMAN.md` naming the exact check names when WP-V4 merges.

### WP-V5 — coverage ratchet
- **Scope:** `@vitest/coverage-v8` in `packages/sdk` and `packages/surface`,
  `cargo llvm-cov` for `kernel/`, `scripts/coverage-ratchet.mjs` comparing
  the PR's numbers to `main`'s committed baseline
  (`.agentworkforce/coverage-baseline.json`); a drop fails, a rise updates
  the baseline in the same PR.
- **DoD:** the ratchet runs in `tests.yml`; a deliberate test deletion on a
  scratch branch is shown failing it (paste output).
- **blocked-by:** WP-V4.

### WP-V6 — fill the thin layers
- Surface: tests for every helper client in `packages/surface/src/helpers/`
  (request shape, error mapping), `cloud.ts`, `memory.ts`, `runtime.ts`.
- `create-flow` and `relayflows` wrappers: scaffold-and-run smoke tests.
- ts-plugin: diagnostics for each rule it ships.
- Manifest `unverified:` count must reach zero for `critical` and `hot`.
- **DoD:** audit exits 0 with no `unverified` on critical/hot; coverage
  ratchet rises for surface.
- **blocked-by:** WP-V5. May be split across ticks by package.

### WP-V7 — autonomous merge
- **Scope:** `.github/workflows/auto-merge.yml`: on `check_suite`/`status`
  completion for an open PR, if every required check is green **at the head
  sha**, the swarm verdict is PASSED, `verdict.json` has no `fail` and no
  critical `skip`, and the diff touches nothing under `ops/IMMUTABLE_PATHS`
  or `.github/workflows/**`, then `gh pr merge --squash --auto`.
- **DoD:** the workflow's decision function is a script with unit tests
  covering each refusal; a dry-run mode logs the decision without merging.
- **blocked-by:** WP-V4, and a **human step**: Khaliq amends RFC-0001 settled
  decision #16 to name this mechanical policy (decision #6 forbids the Lead
  from writing its own authority). Ship the workflow behind a
  `AUTO_MERGE_ENABLED` repository variable defaulting to off until then.

## What this loop may not do

- Merge anything. `ops/autodrive.sh` delivers PRs; a human (or, once WP-V7 is
  enabled by the RFC amendment, the workflow) merges.
- Edit `.github/workflows/review-swarm*.yml`, `workflows/review-swarm.yaml`,
  or `ops/preswarm-check/` — the gates that judge this work (decision #6).
- Widen a package. If a package cannot land as written, say so in
  `ops/NEEDS_HUMAN.md` and stop.
