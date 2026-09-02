# PR #136 fresh exact-head maintainability/adversarial review

- **Exact head:** `4888d1572ed047c5161042614ac72068d047783a`
- **Merged main:** `a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2`
- **Lens:** typo/unknown-model ordering, auth-vs-model classification, wrapper identity, installed Claude/Codex argv, false-positive preflight, and load-bearing test quality.
- **Constitution read in full:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`
- **Mode:** independent assessment only; no product code, merge state, or release state was changed.

## Verdict

**REVIEW_FAILED.** The repair correctly introduces typed Claude/Codex adapters, fixes the old auth-vs-model misclassification, and passes both focused deterministic tests and opt-in tests against the installed providers. Two blocking fail-closed mismatches remain. First, only named declarations are globally scanned for unknown models; a typo in a later inline step allows earlier real provider probes to run before the flow is refused. Second, Codex readiness explicitly bypasses the Git-repository check while actual worker execution does not, so preflight can prove a command shape that the worker immediately rejects from a legal non-Git workspace. The wrapper execution path also does not carry or re-establish the identity proof on which its private environment contract depends.

## Scope and history

```text
$ git status --short --branch
$ git rev-parse HEAD
$ git merge-base a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2 4888d1572ed047c5161042614ac72068d047783a
$ git log --format='%H %s' --reverse a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..4888d1572ed047c5161042614ac72068d047783a
$ git diff --stat a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..4888d1572ed047c5161042614ac72068d047783a | tail -5
## feat/v2-declared-model...origin/feat/v2-declared-model
4888d1572ed047c5161042614ac72068d047783a
a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2
321b27216e561561e1e022a7b4d973e2182ee480 feat(sdk): add declared agent model contract
78efc0d15f32246332f9cf64ffba7f838573d02e docs(review): record PR 136 fresh review
4888d1572ed047c5161042614ac72068d047783a fix(sdk): make model adapters fail closed
 testdata/preflight/echo-model-cli                  |   4 +
 testdata/preflight/signal-probe-cli                |   4 +
 testdata/preflight/unauthenticated-cli             |   4 +
 testdata/preflight/wake-context-probe-cli          |   4 +
 34 files changed, 2308 insertions(+), 106 deletions(-)
```

## F1 — P1: a later inline model typo permits earlier provider calls

The repair pre-scans every named declaration and returns before probes, including unused and shadowed declarations. Inline `step.model` values are still checked inside the same loop that probes each step. Therefore the result depends on author order: a valid first step performs its model round trip before an unknown inline model on a later step is discovered.

```text
$ nl -ba sdk/src/preflight.ts | sed -n '103,126p;145,161p' | sed -E '/^[[:space:]]*[0-9]+[[:space:]]*$/d'
   103	  // Named declarations remain in the normalized authoring object until this
   104	  // boundary so even unused or step-shadowed models are checked. Return before
   105	  // any environment probe; toKernelSpec erases the map and selector only after
   106	  // this authoring preflight has had the chance to fail closed.
   107	  for (const [agent, declaration] of Object.entries(flow.agents ?? {})) {
   108	    if (isKnownModel(declaration.model, options.models)) continue;
   109	    diagnostics.push({
   110	      severity: 'refusal',
   111	      kind: 'model_unknown',
   112	      agent,
   113	      cli: declaration.cli,
   114	      model: declaration.model,
   115	      message: unknownNamedAgentModelMessage(agent, declaration.cli, declaration.model, options.modelRegistryPath),
   116	    });
   117	  }
   118	  if (diagnostics.length > 0) return { ok: false, resolutions, diagnostics };
   120	  for (const step of flow.steps) {
   121	    warnOnUnprovableEffects(step, options.probes, diagnostics);
   122	    if (step.type === 'deterministic') continue;
   124	    const declaredModel = step.model;
   125	    const modelUnknown = declaredModel !== undefined && !isKnownModel(declaredModel, options.models);
   126	    const resolution = resolveCli(step, flow, options.projectCli);
   145	    resolutions.push(resolution);
   146	    if (modelUnknown && resolution.model !== undefined) {
   147	      diagnostics.push({
   148	        severity: 'refusal',
   149	        kind: 'model_unknown',
   150	        stepId: resolution.stepId,
   151	        cli: resolution.cli,
   152	        model: resolution.model,
   153	        message: unknownModelMessage(
   154	          resolution.stepId,
   155	          resolution.model,
   156	          resolution.cli,
   157	          options.modelRegistryPath,
   158	        ),
   159	      });
   160	      continue;
   161	    }
```

Independent reproduction. The `calls` array proves the first CLI/model was probed even though the second step makes the spec deterministically invalid:

```text
$ node --input-type=module -e 'import { preflight } from "./dist/preflight.js"; const calls=[]; const result=preflight({version:"0.1.0",steps:[{id:"first",type:"agent",cli:"claude",model:"known-model",instruction:"First"},{id:"typo",type:"agent",cli:"claude",model:"known-modle",instruction:"Second"}]},{models:["known-model"],modelRegistryPath:"/project/flows.json",probes:{cli(...args){calls.push(args);return {exists:true,supported:true,authenticated:true,modelAvailable:true}},executor(){return true},command(){return true}}}); console.log(JSON.stringify({calls,result},null,2));'
{
  "calls": [
    [
      "claude",
      "step",
      "known-model"
    ]
  ],
  "result": {
    "ok": false,
    "resolutions": [
      {
        "stepId": "first",
        "cli": "claude",
        "source": "step",
        "model": "known-model"
      },
      {
        "stepId": "typo",
        "cli": "claude",
        "source": "step",
        "model": "known-modle"
      }
    ],
    "diagnostics": [
      {
        "severity": "refusal",
        "kind": "model_unknown",
        "stepId": "typo",
        "cli": "claude",
        "model": "known-modle",
        "message": "Step \"typo\" declares model \"known-modle\" for CLI \"claude\", but it is not listed in project model registry \"/project/flows.json\"; add the exact model only after verifying that project is allowed to use it."
      }
    ]
  }
}
```

For raw providers, that probe is a real model call rather than a side-effect-free registry lookup. This violates the PR's outcome that unknown models refuse before any CLI call and makes a deterministic typo capable of spending time/tokens before refusal.

Required repair evidence: collect all named and inline model declarations, validate their exact allowlist membership in one pure first pass, and return all `model_unknown` diagnostics before command, CLI, executor, or daemon probes. Add a two-step regression whose first valid model probe throws if called and whose second inline model is unknown; assert zero probe calls in both step orders.

## F2 — P1: Codex readiness and worker argv disagree on the Git trust prerequisite

The readiness probe uses `--skip-git-repo-check`; the actual worker invocation omits it. `AgentWorker` also supplies no `cwd`, so the child inherits the worker process's directory. Agent steps are legal with relayfile surfaces or no worktree declaration, so a Git repository is not a stated execution prerequisite.

```text
$ nl -ba sdk/src/cli-adapter.ts | sed -n '64,70p;92,100p'
    64	  if (kind === 'codex') {
    65	    return {
    66	      args: [
    67	        'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
    68	        '--model', model, MODEL_PROBE_PROMPT,
    69	      ],
    70	      timeoutMs: 60_000,
    92	  if (kind === 'codex') {
    93	    return {
    94	      args: [
    95	        'exec', '--ephemeral',
    96	        ...(model === undefined ? [] : ['--model', model]),
    97	        instruction,
    98	      ],
    99	      timeoutMs: 0,
   100	    };
```

```text
$ nl -ba sdk/src/worker.ts | sed -n '190,193p;238,240p'
   190	  return new Promise((resolve) => {
   191	    const env: NodeJS.ProcessEnv = { ...process.env };
   192	    const invocation = agentExecution(cliAdapterKind(cli), instruction, model);
   193	    // Explicit unset. Without this, a parent process (wrapper
   238	    }
   239	    const child = spawn(cli, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'], env });
   240	    const stdout: Buffer[] = [];
```

The installed Codex CLI accepts the readiness argv from this exact head and reaches model validation outside a repository:

```text
$ codex exec --ephemeral --sandbox read-only --skip-git-repo-check --model relayflows-definitely-not-a-real-codex-model 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.'; codex_status=$?; printf 'codex_exit=%s\n' "$codex_status"; exit 0
Reading additional input from stdin...
OpenAI Codex v0.152.1
--------
workdir: /Users/khaliqgant/AgentWorkforce/flows-132-model-wt
model: relayflows-definitely-not-a-real-codex-model
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 01a0631b-0159-7fe3-8fbd-6ef1c3fcafd3
--------
user
Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.
warning: Model metadata for `relayflows-definitely-not-a-real-codex-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'relayflows-definitely-not-a-real-codex-model' model is not supported when using Codex with a ChatGPT account."}}
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'relayflows-definitely-not-a-real-codex-model' model is not supported when using Codex with a ChatGPT account."}}
codex_exit=1
```

The actual worker argv from a non-Git directory fails before attempting the declared model. This command was run with `/tmp` as its working directory:

```text
$ codex exec --ephemeral --model relayflows-definitely-not-a-real-codex-model 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.'; codex_status=$?; printf 'codex_worker_argv_exit=%s\n' "$codex_status"; exit 0
Reading additional input from stdin...
Not inside a trusted directory and --skip-git-repo-check was not specified.
codex_worker_argv_exit=1
```

This is a preflight false positive for runnability, independent of model existence: with an accessible allowlisted model, the readiness call can exit zero because it bypasses the check, while execution still exits one solely because the worker cwd is not a Git repository.

Required repair evidence: make readiness and execution share all runnability-relevant Codex flags and cwd assumptions. Add an end-to-end test using the installed Codex CLI from a non-Git directory with a known accessible model, or make a Git worktree a validated declared prerequisite and refuse before the provider call. The deterministic fake CLI test must assert the complete argv, not only the prefix through `--model`.

## F3 — P2: wrapper identity is checked during `flows check` but is not an execution invariant

`cliAdapterKind` labels every executable not literally named `claude` or `codex` as `relayflows-wrapper-v1`. Identification and execution are separate functions; `agentExecution` receives only the enum, not an identity proof. Consequently every custom executable gets `RELAYFLOW_MODEL` at worker execution even when the current executable never returned the required token.

```text
$ node --input-type=module -e 'import { adapterIdentification, agentExecution, cliAdapterKind } from "./dist/cli-adapter.js"; for (const cli of ["/tmp/not-an-adapter","/tmp/team-reviewer","/opt/homebrew/bin/claude","/opt/homebrew/bin/codex"]) { const kind=cliAdapterKind(cli); console.log(JSON.stringify({cli,kind,identify:adapterIdentification(kind),execute:agentExecution(kind,"Review.","declared-model")})); }'
{"cli":"/tmp/not-an-adapter","kind":"relayflows-wrapper-v1","identify":{"invocation":{"args":["--relayflows-adapter-v1"],"timeoutMs":10000},"expectedStdout":"relayflows-agent-cli-v1"},"execute":{"args":["Review."],"timeoutMs":0,"modelEnv":"declared-model"}}
{"cli":"/tmp/team-reviewer","kind":"relayflows-wrapper-v1","identify":{"invocation":{"args":["--relayflows-adapter-v1"],"timeoutMs":10000},"expectedStdout":"relayflows-agent-cli-v1"},"execute":{"args":["Review."],"timeoutMs":0,"modelEnv":"declared-model"}}
{"cli":"/opt/homebrew/bin/claude","kind":"claude","identify":{"invocation":{"args":["auth","status","--help"],"timeoutMs":10000}},"execute":{"args":["-p","--model","declared-model","Review."],"timeoutMs":0}}
{"cli":"/opt/homebrew/bin/codex","kind":"codex","identify":{"invocation":{"args":["login","status","--help"],"timeoutMs":10000}},"execute":{"args":["exec","--ephemeral","--model","declared-model","Review."],"timeoutMs":0}}
```

The live test named “identified wrapper” bypasses `checkFlow` and submits the kernel spec directly. Nothing in lines 691–747 invokes `--relayflows-adapter-v1`; the worker trusts the basename classification. The test therefore cannot fail if execution loses its identity prerequisite:

```text
$ nl -ba sdk/tests/live-kernel.test.ts | sed -n '691,729p' | sed -E '/^[[:space:]]*[0-9]+[[:space:]]*$/d'
   691	  it('AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL', async () => {
   692	    // The whole point of declaring `model` on the step is that the CLI
   693	    // stops inheriting whatever the host pinned. This proves the declared
   694	    // value survives the full boundary: SDK compile → kernel parse →
   695	    // dispatch → AgentWorker → subprocess env.
   696	    const dataDir = temporaryDirectory('flows-live-model-set-');
   697	    await startDaemon(dataDir);
   698	    const cli = join(TESTDATA, 'preflight', 'echo-model-cli');
   699	    const client = await connectClient(dataDir);
   700	    await client.hello('live-model-set');
   701	    const worker = new AgentWorker(client, {
   702	      workerId: 'live-model-set-worker',
   703	      pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] },
   704	    });
   705	    await worker.attach();
   707	    const compiled = compileYaml(`
   708	version: '0.1.0'
   709	agents:
   710	  model-probe:
   711	    cli: ${JSON.stringify(cli)}
   712	    model: declared-model-xyz
   713	steps:
   714	  - id: probe
   715	    type: agent
   716	    agent: model-probe
   717	    instruction: Report the model env var.
   718	`);
   719	    expect(compiled).toHaveProperty('agents.model-probe.model', 'declared-model-xyz');
   720	    expect(compiled.steps[0]).toMatchObject({
   721	      type: 'agent',
   722	      cli,
   723	      model: 'declared-model-xyz',
   724	    });
   725	    const kernel = toKernelSpec(compiled);
   726	    expect(kernel).not.toHaveProperty('agents');
   727	    expect(kernel.steps[0]).not.toHaveProperty('agent');
   728	    const started = await client.runStart(kernel);
   729
```

Normal `flows run` performs preflight before submission, so this is not a claim that its unchanged executable always bypasses identification. The gap is that the proof is neither journaled nor bound to the executable that a potentially remote/later worker resolves; direct journal-protocol submission and executable replacement between preflight and dispatch both bypass it. That contradicts the worker comment that only an explicitly identified wrapper receives the private environment contract.

Required repair evidence: make adapter identity part of the immutable compiled/runtime contract, or re-identify custom wrappers in `AgentWorker` before sending `RELAYFLOW_MODEL`. Add a negative journal-to-worker test with a nonconforming custom executable and assert it completes `worker_error` without running the instruction or receiving the private model variable.

## Repaired behavior that passes

The installed binaries expose the selected adapter shapes and both are authenticated:

```text
$ command -v claude; command -v codex; claude --version; codex --version
/opt/homebrew/bin/claude
/opt/homebrew/bin/codex
2.1.153 (Claude Code)
codex-cli 0.152.1
$ claude auth status >/dev/null 2>&1; printf 'claude_auth_exit=%s\n' "$?"; codex login status >/dev/null 2>&1; printf 'codex_auth_exit=%s\n' "$?"
claude_auth_exit=0
codex_auth_exit=0
```

The repaired preflight taxonomy distinguishes unsupported adapter, authentication failure, inaccessible model, and ready state:

```text
$ node --input-type=module -e 'import { preflight } from "./dist/preflight.js"; const flow={version:"0.1.0",steps:[{id:"review",type:"agent",cli:"tool",model:"known",instruction:"Review"}]}; for (const [label,answer] of [["unsupported",{exists:true,supported:false,authenticated:false}],["unauthenticated",{exists:true,supported:true,authenticated:false,modelAvailable:false,authCommand:"tool login status"}],["model-unavailable",{exists:true,supported:true,authenticated:true,modelAvailable:false,modelCommand:"tool exec --model known"}],["ready",{exists:true,supported:true,authenticated:true,modelAvailable:true}]]) { const result=preflight(flow,{models:["known"],probes:{cli(){return answer},executor(){return true},command(){return true}}}); console.log(label, JSON.stringify({ok:result.ok,kinds:result.diagnostics.map(d=>d.kind)})); }'
unsupported {"ok":false,"kinds":["cli_unsupported"]}
unauthenticated {"ok":false,"kinds":["cli_unauthenticated"]}
model-unavailable {"ok":false,"kinds":["model_unavailable"]}
ready {"ok":true,"kinds":[]}
```

An exact model typo is refused with a useful path, value, registry path, and security-conscious remediation before that declaration's own probe. It deliberately does not auto-suggest changing to a nearby allowed model, which is reasonable for an authorization allowlist:

```text
$ node --input-type=module -e 'import { preflight } from "./dist/preflight.js"; const result=preflight({version:"0.1.0",agents:{reviewer:{cli:"claude",model:"claude-sonnet-4-5"}},steps:[{id:"review",type:"agent",agent:"reviewer",instruction:"Review",cli:"claude",model:"claude-sonnet-4-5"}]},{models:["claude-sonnet-4-6"],modelRegistryPath:"/project/flows.json",probes:{cli(){throw new Error("PROBE_CALLED")},executor(){throw new Error("PROBE_CALLED")},command(){throw new Error("PROBE_CALLED")}}}); console.log(JSON.stringify(result,null,2));'
{
  "ok": false,
  "resolutions": [],
  "diagnostics": [
    {
      "severity": "refusal",
      "kind": "model_unknown",
      "agent": "reviewer",
      "cli": "claude",
      "model": "claude-sonnet-4-5",
      "message": "Named agent \"reviewer\" declares model \"claude-sonnet-4-5\" for CLI \"claude\", but it is not listed in project model registry \"/project/flows.json\"; add the exact model only after verifying that project is allowed to use it."
    }
  ]
}
```

## Verification evidence

Focused TypeScript and deterministic adapter/model/CLI suites:

```text
$ ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/cli-adapter.test.ts tests/model-selection.test.ts tests/validate.test.ts tests/spec-parity.test.ts tests/preflight.test.ts tests/cli.test.ts tests/bin.test.ts --reporter=dot --maxWorkers=1 --minWorkers=1; review_status=$?; echo "exit_code=$review_status"; exit "$review_status"

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

 ✓ tests/cli.test.ts (62 tests) 2997ms
   ✓ flows check CLI > uses the raw Claude adapter model flag instead of accepting auth status as model proof 347ms
 ✓ tests/preflight.test.ts (17 tests) 26ms
 ✓ tests/validate.test.ts (36 tests) 47ms
 ✓ tests/model-selection.test.ts (10 tests) 74ms
 ✓ tests/bin.test.ts (7 tests) 2126ms
   ✓ built flows binary > classifies a signal-terminated auth probe as probe_failed 389ms
   ✓ built flows binary > does not describe a present non-executable CLI as missing 479ms
   ✓ built flows binary > runs one auth probe for three steps sharing a flow CLI 553ms
 ✓ tests/spec-parity.test.ts (15 tests) 131ms
 ✓ tests/cli-adapter.test.ts (3 tests) 11ms

 Test Files  7 passed (7)
      Tests  150 passed (150)
   Start at  19:13:36
   Duration  10.66s (transform 476ms, setup 0ms, collect 1.15s, tests 5.41s, environment 3ms, prepare 1.08s)

exit_code=0
```

Opt-in real-provider preflight suite against the installed CLIs:

```text
$ RELAYFLOWS_REAL_CLI_ADAPTERS=1 ./node_modules/.bin/vitest run tests/real-cli-adapters.test.ts --reporter=verbose --maxWorkers=1 --minWorkers=1; review_status=$?; echo "exit_code=$review_status"; exit "$review_status"

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

 ✓ tests/real-cli-adapters.test.ts > installed raw CLI adapters > round-trips the exact declared Claude model and refuses an impossible one 22299ms
 ✓ tests/real-cli-adapters.test.ts > installed raw CLI adapters > uses Codex login status and classifies an impossible model as unavailable 10792ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  19:10:42
   Duration  35.94s (transform 1.09s, setup 0ms, collect 1.72s, tests 33.10s, environment 0ms, prepare 455ms)

exit_code=0
```

Focused live journal/worker tests against the disclosed existing relayflowd binary:

```text
$ test -x /Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd && echo relayflowd_fixture=executable
$ RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run tests/live-kernel.test.ts -t 'AgentWorker (passes a declared model to an identified wrapper|executes the raw)' --reporter=verbose --maxWorkers=1 --minWorkers=1; review_status=$?; echo "exit_code=$review_status"; exit "$review_status"
relayflowd_fixture=executable

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd
LIVE_KERNEL flows=/Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk/dist/cli.js

 ✓ tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL 932ms
 ✓ tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker executes the raw claude adapter with its real model flag
 ✓ tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker executes the raw codex adapter with its real model flag

 Test Files  1 passed (1)
      Tests  3 passed | 16 skipped (19)
   Start at  19:14:47
   Duration  5.84s (transform 1.29s, setup 0ms, collect 1.81s, tests 1.46s, environment 8ms, prepare 532ms)

exit_code=0
```

Those green tests pin the repaired happy paths but miss F1's cross-step ordering, F2's real worker cwd, and F3's negative wrapper execution. I did not mutate product code, so I make no mutation-verification claim. I also do not claim a fresh full SDK suite; the focused and real-provider commands above are the complete verification claim for this review.

The exact commit diff is whitespace-clean:

```text
$ git diff --check a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..4888d1572ed047c5161042614ac72068d047783a; review_status=$?; echo "exit_code=$review_status"; exit "$review_status"
exit_code=0
```

No merge, release, or self-removal was performed.

REVIEW_FAILED
