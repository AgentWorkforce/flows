# Spend the analysis `flows check` already does

`flows check` computed the facts that would have prevented five dead runs and
said nothing about them. This spends two of them, and establishes that the
third fact is not a fact.

## What changed

### `agent_worker_unresolved` — a check-only warning (permanent)

A spec with `agent` steps needs a worker *attached for step type `agent`*.
Without one the run parks at the first such step. `flows check` already walks
those steps to print `REQUIRES codex (step "implement"), …` — the analysis
exists; it just stopped one sentence short of the remedy.

```
REQUIRES claude (step "implement")
WARNING [agent_worker_unresolved] 2 agent steps ("implement", "review") require an
attached worker. For a local run, use `flows run --local-agent <flow>`, unless you
already attach an agent worker for this daemon. `flows check` does not verify
worker attachment: with no worker attached the run parks at the first agent step.
```

Design decisions worth naming:

- **Warning, never a refusal, worded as a requirement rather than a
  prediction.** Worker attachment is *unknown* to `flows check`, not absent:
  `check` is daemon-free by construction, so it cannot see a worker attached
  elsewhere. Saying "this will park" would be a guess.
- **It is a property of the invocation, not of the spec,** so it opts in
  through a new `CheckInvocation` seam on `checkFlow` / `checkAuthoredFlow`
  rather than entering `preflight`, which stays a pure function of the spec
  plus environment probes. Only `flows check` sets it. `flows run` knows the
  answer (it attaches its own worker under `--local-agent`), `flows build` and
  `flows deploy` check a spec that will run elsewhere, and an SDK caller
  reaching `checkAuthoredFlow` directly is generally running a worker already.
- **Scoped to `agent` steps.** `--local-agent` attaches no `llm` worker on the
  YAML path, so counting `llm` steps and naming that flag for them would be
  false. They are not counted and not mentioned.
- **Counted from the compiled steps, not from `requirements`.** A YAML helper
  step (`slack: { post: … }`) compiles to an `agent` step carrying a helper
  envelope and needs the same SDK worker, but `requirements` reports it as an
  integration, dedupes by harness, and includes `llm` use. Compilation is the
  only walk that sees every step that needs the worker.
- **Emitted in the `REQUIRES` position,** because it reads as a footnote to
  that line. `emitCheckReport` holds it back from the leading diagnostic batch
  and emits it once, after `REQUIRES` and before `CHECK PASSED`; diagnostics
  stay on stderr, report lines stay on stdout. `--json` returns before any of
  that and keeps the single ordered `diagnostics` array.
- **Emitted alongside a preflight refusal.** An environment refusal is fixed
  and rerun; the worker question is still open on the next pass, and staying
  silent about it is what made an author meet it one dead run at a time.

Known blind spot, documented rather than papered over: an authored `.flow.ts`
is checked through `checkMcpHeader`, which preflights a synthetic one-step
header spec without compiling the body, so there are no agent steps to count.
Same blind spot as `permissions_unenforced`.

### `gate_path_unscanned` — a preflight warning (temporary, retires with #513)

An `artifact_exists` gate reads the journaled `output.artifacts` list and
nothing else. The bundled worker's *scan* skips any entry whose name starts
with `.` and any entry named exactly `node_modules`, so a gate on a path inside
one of those prefixes cannot rest on the scan, however faithfully the agent
writes the file:

```
WARNING [gate_path_unscanned] Step "review" gates on artifact_exists path
".workflow-artifacts/rust/review.md", but the bundled agent worker's artifact scan
records nothing under ".workflow-artifacts": it skips entries whose name starts with
"." and entries named "node_modules". The gate reads the journaled output.artifacts
and never the disk, so writing the file is not enough: the step has to report the
path itself — as object-shaped JSON stdout carrying its own "artifacts" array, as a
completed Relay task output, or from a custom worker. If the gate is meant to rest
on the scan, write the artifact to a path the scan records.
```

The issue asked for a refusal, on the premise that such a gate is statically
unsatisfiable. That premise is false, and review F1 is right to reject it: the
scan is only one writer of `output.artifacts`. The same **bundled** worker
promotes object-shaped JSON stdout — and a completed Relay task's output —
verbatim into `output` (`worker.ts`), so an agent that answers with its own
`{"artifacts": [...]}` puts a hidden path in the list and the gate passes; and
`step.complete` accepts any `output` from any worker. Which route a step takes
is a run-time fact, so this reports the scan's limitation and leaves the verdict
to the run. A regression runs the real `AgentWorker` over a fake `claude` that
writes `.workflow-artifacts/review.md` *and* reports it as JSON, then runs the
real lowered gate command over exactly what the worker journaled: the scan
records nothing, the gate exits 0. A refusal would have rejected that spec at
`check`, `run`, `build` and every SDK submission.

- **One rule, two consumers.** The exclusion predicate moved out of
  `agent-artifacts.ts` into `src/artifact-scan-policy.ts`; the real scan now
  consumes it, so the warning cannot drift from the scan it describes. A
  parity test writes all twelve case paths to a temp dir and asserts the real
  `snapshotWorkspaceFiles` output is exactly the predicate's complement.
- **The whole excluded prefix is named,** not the offending segment alone —
  that prefix is the directory an author relying on the scan has to move the
  artifact out of.
- **Segments are compared exactly, with no normalization.** The gate matches
  the author's literal string against the worker's literal list, so
  `node_modules-copy/out.md`, `reports/node_modules.md`, `review.md` and
  `reports/v1.2/review.md` say nothing, and a backslash is an ordinary
  filename character rather than a separator.
- **Collected before preflight's early returns.** `probeNamedGate` runs after
  CLI resolution, model governance, scope and budget can each return, so an
  author with an unresolved CLI would not learn about the unscanned path until
  a later pass — or at run time. A test pins the diagnostic order as
  `['gate_path_unscanned', 'cli_unresolved']`.
- **It lives in `PREFLIGHT_WARNING_KINDS`,** so it travels with every public
  preflight consumer — `flows check`, `run`, `build` and SDK submissions — and
  refuses none of them.

### `gate_output_not_captured` — **not added**, because it is not true

The acceptance criterion was conditional: warn that a `subprocess_gate`'s
output is not captured *"for as long as that is true"*. It is not true today.
Verified against a live `relayflowd` before writing anything:

```
"stepId": "emit.gate", "completionReason": "retries_exhausted", "exitCode": 1,
"stdoutTail": "GATE_STDOUT_MARKER\n", "stderrTail": "GATE_STDERR_MARKER\n"
```

and in the journal itself, on the lowered gate step's `step.completed`:

```json
"output": { "exit_code": 1, "stdout_tail": "GATE_STDOUT_MARKER\n",
            "stderr_tail": "GATE_STDERR_MARKER\n" }
```

A warning claiming otherwise would have been a false diagnostic added to a
change whose whole point is that `check` should only say what it knows. What
the criterion actually asks for is that the warning exist exactly while the
bug does — so instead of the warning, this adds a **live-kernel regression
that pins the capture**. If capture ever regresses, that test fails, and the
warning becomes warranted at the moment it becomes true.

## Tests

- `tests/artifact-gates.test.ts` — six parameterised warnings asserting the
  full excluded prefix is named and that none of them refuses; six lookalike
  paths that must say nothing; the scan/predicate parity test against a real
  `snapshotWorkspaceFiles` run; the early-return ordering test; an end-to-end
  `checkFlow` case pinning the warning and the unrelated refusal beside it;
  and the F1 regression described above, which drives the real `AgentWorker`
  and the real lowered gate command over an excluded path the agent reports
  itself.
- `tests/check-worker-surface.test.ts` (new) — message content, singular vs
  plural and the "and N more" truncation, exit code 0, the YAML helper step
  being counted where `requirements` omits it, silence for `llm`-only and
  deterministic-only flows, survival alongside a preflight refusal, opt-in
  discipline, `--json` emitting it once in both the payload and on stderr, and
  an **ordered `CliIo` transcript** (both streams in one list) pinning the
  position after `REQUIRES` and before `CHECK PASSED` — in both the
  `REQUIRES`-present and `REQUIRES`-absent shapes.
- `tests/preflight.test.ts` — `gate_path_unscanned` added to the
  warning-reachability list, which asserts set equality against
  `PREFLIGHT_WARNING_KINDS`.
- `tests/live-kernel.test.ts` (new block) — the `subprocess_gate` capture
  regression, asserting both the rendered message and the journal payload, with
  a silent-gate control so the assertions cannot pass on a fixed string.

`npm test` in `packages/sdk`: 2381 passed, 40 failed. All 40 failures are
pre-existing and environmental — they reproduce identically on a stashed tree
(same 40 failures, same 7 files): `relayflowd` looked up under
`kernel/target/{debug,release}/` while this toolchain builds outside the repo,
and flows needing real harness CLIs. `tsc --noEmit` is clean for `src`, the
type tests, and `tests`.

## Files

| File | Change |
| --- | --- |
| `src/artifact-scan-policy.ts` | new — the scan's exclusion rule as a pure predicate, shared |
| `src/named-gate-preflight.ts` | new — the `gate_path_unscanned` warning (retires with #513) |
| `src/cli/check-worker-surface.ts` | new — the `agent_worker_unresolved` warning |
| `src/agent-artifacts.ts` | consumes the extracted predicate instead of its own copy |
| `src/preflight.ts` | collects gate scan coverage before every early return |
| `src/failure-kinds.ts` | the two new kinds, each with its retirement note |
| `src/cli/check.ts` | `CheckInvocation` opt-in seam |
| `src/cli.ts` | opts in at the `check` dispatch; defers the warning to the `REQUIRES` position |
| `docs/SURFACE.md` | documents both kinds where the facts they describe already live |

Each diagnostic is a distinct kind, so it can be suppressed and later deleted
on its own. Both temporary kinds carry their retirement condition in a comment
at the definition site.

## Out of scope, unchanged

The underlying bugs (#511, #513) are not fixed, and the spec is not
round-tripped past the daemon's validator (#502).
