# examples/research — a fan-out research relayflow, authored on flows v2

Give it a research question. It fans the question out to three independent
model lanes — **Claude** (sonnet), **Codex**, and **Grok** — each of which
spawns **two subagents** (a *landscape* researcher over papers, frameworks,
and vendor docs, and an *applied* researcher who reads the local repos and
designs for the concrete case), verifies and merges their work, and writes
a report. A fourth agent then **synthesizes** the three reports into one,
attributing agreement and disagreement to lanes.

The flow is `research.flow.ts`, written in the v2 dialect
(`docs/SURFACE.md`), the same way `regressions/` in this repo and the sales
harness in the sibling `AgentWorkforce/sales` repository (`sales/harness`,
checked out as `../sales`) are:
the file declares the narrow slice of the surface it needs, and `shims/`
provide that slice on today's runtime, each with a `REPLACE-WHEN:` header.

```
examples/research/
  research.flow.ts       the relayflow — three agent steps in Promise.all, one synthesis, postfix gates
  briefs.ts              pure brief builders: lane protocol + synthesis protocol
  shims/headless.ts      REPLACE-WHEN the SDK AgentWorker owns headless adapters: how each CLI is
                         invoked non-interactively and how its structured output is read
  shims/agent-cli.ts     REPLACE-WHEN gate-1 agent dispatch: spawns the CLI through its adapter
  shims/run.ts           REPLACE-WHEN `flows run` accepts v2 with input: the entry point
  tests/research.test.ts node:test over a fake agent runtime: fan-out, gates, briefs, parsers
  tests/adapter.test.ts  the real adapter driven by a scripted stub binary
  questions/             research questions worth keeping (inputs)
  runs/<date>-<slug>/    PROMPT.md, SYNTHESIS.md, synthesizer.{prompt.md,log}
    <lane>/              one workspace per lane: report.md, <lane>.prompt.md, <lane>.log,
                         <lane>.trajectory.jsonl (the CLI's structured event stream)
```

## Run

```sh
node --experimental-strip-types examples/research/shims/run.ts \
  --slug agent-memory --question-file examples/research/questions/agent-memory.md
# or: --question "free text"      --timeout-minutes 30 (default; PER STEP — three concurrent lanes then one synthesis, so up to 2× wall-clock)
```

Requires `claude`, `codex`, and `grok` on `PATH`, each authenticated. The
entry point preflights them before creating anything: `claude auth status`
and `codex login status` are real probes; Grok has no auth probe, so only its
binary and `--version` are checked and an expired Grok login still surfaces
at dispatch. Exit 0 prints the result (`completionReason: synthesized`, the
report paths, one usage line per step); exit 1 names the failed step and its
`completionReason` (`worker_error`, `timeout`, `gate_failed`, `aborted` for a
sibling stopped because another step failed — it appears in that sibling's
own log, never as the run's reported reason, which is always the step that
failed first — or `protocol_error` for anything outside that taxonomy,
reported with step `(unknown)`); the set is `COMPLETION_REASONS` in
`research.flow.ts` and a test pins it to this list; when one step fails,
the still-running sibling agents are killed so a failed run stops spending;
exit 2 means
refused before anything ran (bad arguments, preflight, or a non-empty run
directory — a run never interleaves with a previous one's files).

**The three CLIs run with their permission prompts disabled**
(`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
`--always-approve`) from the repo root. Nothing here contains what they write;
see Known limitations. The run directory holds the exact prompt each lane received, its full
transcript, its structured trajectory, and its report; `runs/current` points
at the latest run. It does not bound what an agent could have read or written
elsewhere, see Known limitations.

Tests and typecheck:

```sh
npm --prefix examples/research test          # node --experimental-strip-types --test tests/*.test.ts
npm --prefix examples/research run typecheck # sdk's ./node_modules/.bin/tsc, not npx (npx would fetch an unrelated tsc and "pass")
```

**These are not run by any gate.** This repository has no CI workflows and
`sdk`'s `npm test` is scoped to `sdk/`. The Safety properties below cite these
tests as evidence; that evidence exists only when someone runs the two
commands. Wiring `examples/*` into a runner is a follow-up.

## How the flow maps to the kernel

| In the flow | Today (shim) | On the kernel |
|---|---|---|
| `f.agent(lane, { task, workspace })` | spawn the lane's CLI **headless, with structured output** (`claude -p --output-format stream-json --verbose`, `codex exec --json`, `grok --output-format json`); task via stdin or prompt file | `agent` step dispatched to the SDK AgentWorker through a per-CLI headless adapter (issue #141) |
| `AgentResult.usage` / `.trajectory` | parsed from the CLI's final event; events written to `<name>.trajectory.jsonl` | the step's budget line (decision 10) and trajectory (Appendix A) in the journal |
| `AgentResult.sessionId` / `.subagents` | recorded from the CLI's output; read by nothing in the flow | no kernel mapping yet; evidence for a human |
| `agents:` header with `cli` / `model` | model passed on the CLI's model flag (what selects it) and exported as `RELAYFLOW_MODEL` for wrappers; never inherited | `AgentStepSpec.cli` / `.model`, journaled with the step |
| `Promise.all` over the three lanes | three concurrent processes | three steps with `dependsOn: []` — concurrent once the kernel dispatches in parallel; serial today |
| `workspace: "<dir>: readwrite"` | **not enforced**: decides where prompt, log and trajectory land and which top-level files count as artifacts; the CLI itself runs unsandboxed from the repo root | declared workspace surface (RFC Appendix A rule 1), enforced by gate 8 |
| `.gate(r => r.artifacts.includes(path))` | artifacts = top-level files of the workspace dir that are new or changed | the step's workspace diff (RFC Appendix A) |
| `.gate(r => r.usage !== undefined)` | the adapter refuses output with no usage record, so this gate documents the contract | budget line journaled with the step (decision 10) |
| non-zero CLI exit | `worker_error`, step fails, run fails | same |
| `f.done("synthesized", …)` | returned result | run completion with `completionReason` |

The gates judge the **workspace**, not the transcript: a lane passes only if
the report file it was told to write exists after it exits. A lane can print
`RESEARCH_REPORT_WRITTEN` and still fail if the file is missing, which is the
point — substring gates on model output are fail-open (see
`ops/preswarm-check/README.md` for the same lesson).

## Why it is not a YAML flow yet

The v0.1.0 YAML dialect embeds a static `instruction` per `agent` step, and
the kernel's AgentWorker spawns the declared CLI with that instruction as
its single argument. A research flow's instruction *is* the question, which
only exists at run time. The v2 dialect takes input naturally
(`run(f, input)`), so this is written there, and the CLI shim carries the
run-time task. The surface gaps this flow needs closed are listed at the top
of `research.flow.ts`; each is a line item for gate-1 SDK work, not a reason
to widen the kernel vocabulary.

## Safety properties

- **Gates seal at the first await.** A `.gate()` after `await` throws
  (`LateGate`) rather than silently never running.
- **A failed step kills its siblings, and waits for them to die.** On
  failure `runResearch` aborts a signal every step holds, so a step that has
  not spawned yet refuses to (`aborted`), then `killLiveAgents()` kills the
  ones that had and awaits their close. `tests/adapter.test.ts` records the
  sibling pids and asserts each is gone (`ESRCH`) by the time the run has
  rejected.
- **Exit 2 means nothing was created.** Every refusal (arguments, preflight,
  non-empty run dir, `runs/current` not a symlink) is checked before the run
  dir exists; `tests/adapter.test.ts` pins the ordering through `main()`.
- **Artifacts are detected by content.** The workspace snapshot keys on size
  plus sha256, so a same-size rewrite still counts; `tests/adapter.test.ts`
  rewrites an 8-byte file with 8 different bytes and asserts it is reported.
- **No empty success.** A CLI exit 0 with an empty final message or no usage
  record is `worker_error`.
- **Ctrl-C stops the agents.** The entry point handles `SIGINT`/`SIGTERM` by
  aborting and killing every live agent step, then exits 130/143.
  `tests/adapter.test.ts` interrupts a real run with three live stub agents
  and asserts each is dead. Without this, detached permission-bypassed CLIs
  would outlive the operator's interrupt with no timeout left.

## Known limitations

- **Preflight diverges from SURFACE.md law 6.** The surface contract says a
  preflightable CLI answers `<cli> auth status`; only Claude does. Codex is
  probed with `login status`, Grok only with `--version`. Gate 1's
  `flows check` will refuse both until they (or wrappers) answer the contract.

- **No workspace containment.** The flow declares a workspace per lane, and
  the shim honors it only for bookkeeping. Each CLI runs with its approval
  prompts bypassed and can write anywhere the operator can. RFC-0001
  Appendix A rule 1 puts undeclared surfaces outside the step's permissions;
  that enforcement is gate-8 kernel work and is not deferred here by accident
  but because a shim cannot provide it.
- **The adapter is pinned by a scripted stub, not by the real CLIs.**
  `tests/adapter.test.ts` runs `runAgentWithCli` against a stub binary that
  emits each CLI's verified output shape, which pins artifact detection, the
  own-file exclusion, `RELAYFLOW_MODEL` handling, trajectory writing and the
  worker_error paths. The live CLIs are exercised only by an actual run.

- **Serial on the kernel, parallel in the shim.** The kernel starts one
  runnable step at a time (`kernel/relayflowd-core/src/machine.rs`
  `next_actions`). The flow is written for parallel dispatch and loses
  nothing when the kernel catches up.
- **Subagent count is instructed, not enforced.** Each lane is told to spawn
  exactly two subagents; the CLIs (Claude's Agent tool, Codex `multi_agent`,
  Grok subagents) do so in their own way, and the transcript in `<lane>.log`
  is the evidence. Nothing in the shim can count them.
- **No budget enforcement.** The header declares `$15/run`; nothing meters
  it until the kernel's budget envelope lands.
- **Lane failure fails the whole run.** There is no partial synthesis over
  two of three reports. Re-run with a **new `--slug`** (or move the failed
  run's directory aside): the run dir is `<date>-<slug>` and a non-empty one
  is refused, so a same-day re-run under the same slug exits 2.
- **The first run's committed prompt files record pre-move paths**
  (`flows/research/runs/…`); the flow lived at `research/` when they were
  written. They are historical evidence and are not rewritten.
- **The first run (2026-09-02) predates the headless adapter.** Its Claude
  lane was invoked with a bare `claude -p`, so `claude/claude.log` holds one
  line and the only evidence of its two subagents is the report's own
  attributions. Runs after this commit record every CLI's structured event
  stream, usage, cost, session id and (for Claude) `subagent_stats`.
- **No trajectory for Grok beyond its final object.** `grok --output-format
  json` returns one object; its `streaming-json` mode was not adopted because
  it was not verified to end with a usage record.
- **Model names are CLI aliases** (`sonnet`, `opus`); Codex and Grok use
  their CLI defaults because their aliases are not pinned here.
