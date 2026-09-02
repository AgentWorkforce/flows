# PR #136 — maintainability / API / type-honesty review

- **PR:** #136 — `feat(sdk): declare agent CLI and model with fail-closed checks`
- **Exact head reviewed:** `321b27216e561561e1e022a7b4d973e2182ee480`
- **Base reviewed:** merged `main` at `a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2`
- **Lens:** maintainability, API/type honesty, fail-closed taxonomy, load-bearing tests,
  exact model-registry/offline semantics, and real CLI auth preflight
- **Constitution read in full:** `AGENTS.md` and
  `docs/RFC-0001-everything-is-a-relayflow.md`
- **Issue/PR material read:** issue #132, the complete one-commit diff/history, and the
  complete PR body
- **Mode:** assessment only. I did not edit product code, commit, push, merge, or
  self-remove. The only non-report files created were disposable fixtures under
  `/tmp/pr136-real-cli.u3fo9m/`.

## Verdict

**FAIL.** The authoring/compiler and journal lowering are sound, but the advertised
`{ cli, model }` contract is not true for the real CLIs named by the surface. A bare
`claude` declaration passes `flows check` for an allowlisted impossible model, while a
logged-in `codex` is refused as unauthenticated because `codex auth status` is not a
real Codex command. At execution the generic worker passes the model only through the
project-specific `RELAYFLOW_MODEL` environment convention and never supplies the real
CLI model flag. This can silently execute a different host-default model after a green
preflight, which is the exact ambient-model failure this PR says it closes.

## Scope confirmation

```text
$ git rev-parse HEAD
321b27216e561561e1e022a7b4d973e2182ee480
$ git rev-parse a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2
a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2
$ git log --format='%H %s' a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..HEAD
321b27216e561561e1e022a7b4d973e2182ee480 feat(sdk): add declared agent model contract
$ git diff --check a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..HEAD; echo "EXIT=$?"
EXIT=0
$ gh pr view 136 --repo AgentWorkforce/flows --json headRefOid,baseRefOid,state,title
{"baseRefOid":"a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2","headRefOid":"321b27216e561561e1e022a7b4d973e2182ee480","state":"OPEN","title":"feat(sdk): declare agent CLI and model with fail-closed checks"}
```

## Findings

### F1 — HIGH — the declared model does not control the advertised bare CLI

The surface's canonical named-agent example is literally
`{ cli: claude, model: claude-sonnet-4-6 }` (`docs/SURFACE.md:69-74`). The type says the
declared model is the model the CLI “should use” (`sdk/src/spec.ts:143-150`). However,
the generic worker does only this:

- remove ambient `RELAYFLOW_MODEL`;
- set `RELAYFLOW_MODEL` to the journaled model;
- spawn `cli` with only `[instruction]` (`sdk/src/worker.ts:200-206,236`).

The installed real CLIs expose model selection as command-line options, not as this
Relayflows-private environment contract:

```text
$ claude --help | rg -n -- '--model|RELAYFLOW_MODEL'
104:  --model <model>                       Model for the current session. Provide
$ codex --help | rg -n -- '--model|RELAYFLOW_MODEL|login'
12:  login             Manage login
76:  -m, --model <MODEL>
```

No `RELAYFLOW_MODEL` support is advertised. The repo's one real Claude runtime works
only because `testdata/preflight/analyze-story-claude-cli` is a bespoke adapter that
reads `RELAYFLOW_MODEL` and translates it to `claude -p --model MODEL`. The generic
worker does not do that, and the PR's live lowering test uses
`testdata/preflight/echo-model-cli`, another bespoke fixture
(`sdk/tests/live-kernel.test.ts:691-741`).

Consequences:

1. `cli: claude` can be preflight-green but execute the host-selected model rather than
   the journaled model.
2. `cli: codex` is not invoked in Codex's non-interactive `exec` shape and receives no
   `-m/--model` argument.
3. The journal remains internally honest about what was *declared*, but it is not proof
   of what provider/model actually ran.

This violates RFC covenant 2 and the PR outcome “the choice is journaled, never
inherited from the host.” Fix this at a typed CLI-adapter boundary: each supported CLI
needs an explicit auth probe and invocation mapping (including model argument), or the
surface must require and identify a conforming wrapper rather than advertising raw
`claude`/`codex` executables. A private env convention alone is not a portable CLI/model
contract.

### F2 — HIGH — the real auth/model probe produces both a false pass and a false refusal

`probeCli` treats exit 0 from `<cli> auth status` with `RELAYFLOW_MODEL` set as proof
that the exact model is usable (`sdk/src/cli/check.ts:194-217`). `runAuthProbe` invokes
that same command for every CLI (`sdk/src/cli/check.ts:220-235`). This assumption is
not true for the actual CLIs named by the API.

Direct executable evidence:

```text
$ env -u RELAYFLOW_MODEL claude auth status >/dev/null 2>&1; echo "CLAUDE_UNSCOPED_EXIT=$?"
CLAUDE_UNSCOPED_EXIT=0
$ RELAYFLOW_MODEL=definitely-not-a-real-model claude auth status >/dev/null 2>&1; echo "CLAUDE_IMPOSSIBLE_MODEL_EXIT=$?"
CLAUDE_IMPOSSIBLE_MODEL_EXIT=0
$ env -u RELAYFLOW_MODEL codex auth status >/dev/null 2>&1; echo "CODEX_UNSCOPED_EXIT=$?"
CODEX_UNSCOPED_EXIT=2
```

The end-to-end `flows check` counterexample used the following exact allowlist and
flows:

```text
$ sed -n '1,80p' /tmp/pr136-real-cli.u3fo9m/flows.json /tmp/pr136-real-cli.u3fo9m/claude.flow.yaml /tmp/pr136-real-cli.u3fo9m/codex.flow.yaml
{"models":["definitely-not-a-real-model"]}
version: '0.1.0'
agents:
  reviewer:
    cli: claude
    model: definitely-not-a-real-model
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review.
version: '0.1.0'
agents:
  reviewer:
    cli: codex
    model: definitely-not-a-real-model
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review.
$ node sdk/dist/cli.js check /tmp/pr136-real-cli.u3fo9m/claude.flow.yaml; echo "CLAUDE_CHECK_EXIT=$?"
RESOLVED step "review" cli "claude" model "definitely-not-a-real-model" from step
CHECK PASSED /tmp/pr136-real-cli.u3fo9m/claude.flow.yaml
CLAUDE_CHECK_EXIT=0
$ node sdk/dist/cli.js check /tmp/pr136-real-cli.u3fo9m/codex.flow.yaml; echo "CODEX_CHECK_EXIT=$?"
REFUSED [cli_unauthenticated] Step "review" declares CLI "codex", but "codex auth status" exited non-zero; authenticate it or implement that probe to return exit 0 when authenticated.
RESOLVED step "review" cli "codex" model "definitely-not-a-real-model" from step
CODEX_CHECK_EXIT=2
```

The Claude result is a fail-open false positive for exact model access. The Codex
result uses the wrong taxonomy: an unsupported probe verb is reported as
`cli_unauthenticated`, telling an already-authenticated operator to authenticate. A
nonzero status cannot distinguish “credential rejected” from “this CLI has no such
probe,” so the taxonomy is typed but not truthful.

The new integration tests cannot catch either defect because
`namedAgentProject()` creates a shell fixture specifically programmed to accept
`auth status` and interpret `RELAYFLOW_MODEL` (`sdk/tests/cli.test.ts:68-96`). Those
tests are valuable protocol tests, but they are not real-CLI compatibility tests.
The custom analyzer wrapper is real and model-scoped, but it does not prove the
documented bare-CLI example.

## Contracts that PASS at this head

### Compiler/type boundary and deterministic precedence

- Runtime validation requires exact named declaration keys `{ cli, model }`, requires
  both fields, rejects malformed/empty/untrimmed/control-character models, and rejects
  unknown agent selectors. Unknown-key diagnostics use author vocabulary and suggestions.
- `compileSpec` resolves named declarations before normalization, then drops the
  `agents` map and `agent` selector. Explicit step `cli` and `model` win independently
  over the named declaration; anonymous steps remain unresolved for the existing
  flow/project CLI precedence (`sdk/src/compile.ts:66-83,134-157`).
- The nearest `flows.json` owns one closed, exact, case-sensitive `models` array.
  Missing allowlist membership refuses as `model_unknown` before a CLI or daemon is
  contacted. Malformed entries and duplicates refuse as `config_invalid`
  (`sdk/src/cli/check.ts:129-167`; `sdk/src/preflight.ts:94-141,155-169`). This is a
  deterministic offline approval list. It is not a provider catalog, which is acceptable
  only if the live adapter probe is repaired per F2.

Focused command and complete captured output:

```text
$ ./node_modules/.bin/tsc --noEmit
$ ./node_modules/.bin/vitest run tests/model-selection.test.ts tests/validate.test.ts tests/spec-parity.test.ts tests/preflight.test.ts tests/cli.test.ts --reporter=dot

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

 ✓ tests/preflight.test.ts (15 tests) 35ms
 ✓ tests/validate.test.ts (36 tests) 98ms
 ✓ tests/model-selection.test.ts (10 tests) 104ms
 ✓ tests/spec-parity.test.ts (15 tests) 234ms
 ✓ tests/cli.test.ts (57 tests) 1956ms

 Test Files  5 passed (5)
      Tests  133 passed (133)
   Start at  18:14:15
   Duration  4.51s (transform 1.38s, setup 0ms, collect 3.29s, tests 2.43s, environment 5ms, prepare 2.74s)
```

`tsc --noEmit` emitted no output and the chained command continued into Vitest, so its
exit was zero.

### Existing journal fields, not new kernel vocabulary

The named sugar lowers to the existing agent step `cli` and `model` fields. The focused
live test asserts the compiled shape, `run.spawned.payload.spec.steps[0].model`, and the
worker-observed model after a real relayflowd boundary. Captured execution:

```text
$ RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run tests/live-kernel.test.ts -t 'AgentWorker passes a declared model to the CLI as RELAYFLOW_MODEL' --reporter=verbose --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd
LIVE_KERNEL flows=/Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk/dist/cli.js

 ✓ tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker passes a declared model to the CLI as RELAYFLOW_MODEL

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  18:18:02
   Duration  1.42s (transform 354ms, setup 0ms, collect 512ms, tests 304ms, environment 0ms, prepare 163ms)
```

This proves lowering/journaling/env transport. It does not prove a real bare CLI honors
the env value; that distinction is the substance of F1.

### Existing inline/default behavior

The three canonical ladder flows still pass `flows check`; the agent and llm retain
their pre-existing inline `model` plus project-CLI resolution and deterministic flows
remain unaffected:

```text
$ node sdk/dist/cli.js check testdata/hello-agent.flow.yaml; echo "EXIT=$?"
WARNING [unprovable_effects] Step "greet" command "printf" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "finish" command "printf" resolves, but its effects cannot be proven before execution.
RESOLVED step "edit" cli "./preflight/authenticated-cli" model "test-model-v1" from project (/Users/khaliqgant/AgentWorkforce/flows-132-model-wt/testdata/flows.json)
CHECK PASSED testdata/hello-agent.flow.yaml
EXIT=0
$ node sdk/dist/cli.js check testdata/hello-llm.flow.yaml; echo "EXIT=$?"
WARNING [unprovable_effects] Step "greet" command "printf" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "finish" command "printf" resolves, but its effects cannot be proven before execution.
RESOLVED step "answer" cli "./preflight/authenticated-cli" model "deterministic-test-stub" from project (/Users/khaliqgant/AgentWorkforce/flows-132-model-wt/testdata/flows.json)
CHECK PASSED testdata/hello-llm.flow.yaml
EXIT=0
$ node sdk/dist/cli.js check testdata/hello-deterministic.flow.yaml; echo "EXIT=$?"
WARNING [unprovable_effects] Step "greet" command "echo" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "shout" command "echo" resolves, but its effects cannot be proven before execution.
CHECK PASSED testdata/hello-deterministic.flow.yaml
EXIT=0
```

### TypeScript `FlowHeader` scope is honest

The issue asks for `agents:` with model on the TypeScript header, but this branch has no
canonical `FlowHeader` implementation to amend. The PR does **not** claim otherwise:
its body calls this the YAML/JSON compiler contract and explicitly defers
`FlowHeader.agents` until the separately reviewed, unmerged surface package lands.
`docs/SURFACE.md:117-121` repeats that limitation. Exporting `NamedAgentSpec` and adding
`FlowSpec.agents` is truthful for the declarative SDK shape; it is not represented as
completion of issue #132's TypeScript header item.

## Whole-suite evidence

The full serial SDK suite passed at the exact head, including the custom real-Claude
analyzer, live journal/kernel tests, and crash/resume. Its success does not close F1/F2
because none of its real-CLI cases exercises the documented bare `cli: claude` contract;
the real analyzer uses the translating wrapper described above.

```text
$ RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run --reporter=dot --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd
LIVE_KERNEL flows=/Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk/dist/cli.js

stdout | tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
LIVE_ANALYZER ready: claude -p --model claude-haiku-4-5-20251001 round-trip OK

stdout | tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
LIVE_ANALYZER analysis: {"reasoning":"This story is highly relevant to AI agents and automation as it demonstrates a concrete implementation of an autonomous agent performing core software development tasks (opening and reviewing pull requests). The agent demonstrates self-directed capability and workflow automation, which are central themes in agent development and align directly with autonomous systems design.","relevance_score":9,"story_title":"Show HN: an agent that opens and reviews its own pull requests [wake-nonce-7f3a91c4]"}

stdout | tests/live-kernel.test.ts > surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once
LIVE_KERNEL kill -9 pid=48527 run=01M1HEHN0P6HWSQZ865SAFQ5DY while step=two state=Running

 ✓ tests/live-kernel.test.ts (17 tests) 63060ms
 ✓ tests/cli.test.ts (57 tests) 2292ms
 ✓ tests/journal-client.test.ts (13 tests) 152ms
 ✓ tests/validate.test.ts (36 tests) 49ms
 ✓ tests/cli-hn-monitor.test.ts (16 tests) 109ms
 ✓ tests/preflight.test.ts (15 tests) 22ms
 ✓ tests/backlog-picker.test.ts (14 tests) 241ms
SKIPPED_UNACTIONABLE=0
SKIPPED_UNACTIONABLE=0
NO_ACTIONABLE_BACKLOG_ENTRY scanned=0
node:fs:539
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^

Error: ENOENT: no such file or directory, open '.relayflow/backlog-picker-entry.json'
    at Object.readFileSync (node:fs:539:20)
    at [eval]:1:478
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:483:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:481:60)
    at evalFunction (node:internal/process/execution:315:30)
    at evalTypeScript (node:internal/process/execution:327:3)
    at node:internal/main/eval_string:71:3 {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '.relayflow/backlog-picker-entry.json'
}

Node.js v26.7.0
SKIPPED_UNACTIONABLE=0
 ✓ tests/backlog-picker-flow.test.ts (6 tests) 1494ms
SKIPPED_UNACTIONABLE=0
NO_ACTIONABLE_BACKLOG_ENTRY scanned=1 Scoped but unverifiable[missing_definition_of_done]
 ✓ tests/work-package-consumer.test.ts (13 tests) 640ms
 ✓ tests/model-selection.test.ts (10 tests) 44ms
 ✓ tests/deterministic-llm.test.ts (5 tests) 31ms
 ✓ tests/bin.test.ts (7 tests) 2176ms
 ✓ tests/hn-poller.test.ts (6 tests) 55ms
 ✓ tests/dir-watcher-poller.test.ts (6 tests) 77ms
 ✓ tests/hello-deterministic.test.ts (5 tests) 71ms
 ✓ tests/work-package-validator.test.ts (7 tests) 16ms
 ✓ tests/spec-parity.test.ts (15 tests) 173ms
 ✓ tests/parse-json-output.test.ts (7 tests) 5ms

 Test Files  18 passed (18)
      Tests  255 passed (255)
   Start at  18:15:57
   Duration  89.79s (transform 2.86s, setup 0ms, collect 5.25s, tests 70.71s, environment 10ms, prepare 4.00s)
```

The ENOENT stack is emitted by an expected negative-path child exercised by
`backlog-picker-flow.test.ts`; the Vitest process exited zero and reported all 255 tests
passing.

## Required repair and regression gates

1. Establish a typed adapter/runner contract per supported CLI. For the docs' raw
   `claude` example, invoke non-interactively with the declared `--model`; for Codex,
   use its actual login/status and `exec --model` shapes. If raw provider CLIs are not
   supported, refuse them with an honest kind and document that `cli` must be a
   conforming Relayflows adapter.
2. Make scoped readiness actually exercise or query the exact model. Unsupported probe
   verbs must be `probe_failed`/unsupported-contract (or a new closed kind), not
   `cli_unauthenticated`.
3. Add executable tests against the supported real CLI adapters. Keep the current fake
   probe tests for deterministic taxonomy, but do not present them as provider auth/model
   evidence.
4. Retain the current compiler/lowering, allowlist, precedence, inline/unset, and
   `run.spawned` assertions; those parts are good and should not be rewritten to fix the
   adapter boundary.

REVIEW_FAILED
