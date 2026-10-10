# Flow evaluation: re-run as a deploy gate

`flows replay` reads a finished run's journal and executes nothing. `flows eval`
and `evaluateFlow` do the other thing. They **re-execute** one exact flow version
against a frozen suite of input cases and return a score report. The report's
`gate.pass` is the deploy decision.

## Suite

```json
{
  "name": "triage-regressions",
  "cases": [
    { "id": "happy", "input": { "ticket": "AR-1" } },
    { "id": "declines-empty", "input": {}, "expect": { "completionReason": "declined" } },
    { "id": "names-ticket", "input": { "ticket": "AR-2" },
      "expect": { "detailIncludes": ["AR-2"], "maxLatencyMs": 60000, "maxCostUsd": 0.5 } }
  ],
  "thresholds": { "minPassRate": 1, "maxTotalCostUsd": 2, "maxP95LatencyMs": 120000 }
}
```

- **`expect.completionReason`** defaults to `success`. Other values: `declined`,
  `step_failed`, `budget_exceeded`, `canceled`, `needs_human`,
  `worker_unavailable` (parked with no worker attached), `refused`.
- **`expect.detailIncludes` / `detailMatches`** check the run's completion
  detail, which is what the body passed to `f.done(reason, { detail })`.
- **An unknown cost never passes a cost ceiling.** A negative or non-finite
  reported cost counts as unknown.
- **`minPassRate` defaults to 1.** An *errored* case was never judged, so it
  fails the gate whatever the pass rate is.
- **Unknown fields are refused.** A typo in `expect` cannot silently weaken a gate.

## What a report pins

Every report records:

- **`flow.version`**: for a flow file, the sha256 of a manifest of every
  local source the run reads. That covers the entry, its relative imports and
  `use`d flows, transitively (both siblings when `./x.js` and `./x.ts` exist),
  plus the nearest `package.json`, `flows.json`, `flows.lock.json` and
  package lockfile. `flow.files` lists them. For an
  in-memory spec, it is the compiled kernel spec hash. Packages under
  `node_modules` are pinned by the lockfile in the manifest, not hashed
  file by file;
- **`suite.sha256`**: the sha256 of the suite's canonical JSON.

`--expect-version` (`expectVersion`) refuses to evaluate any flow bytes other
than the pinned ones. `expectSuiteSha256` refuses any other suite.
**Every case executes its own sealed copy, never the working tree.** The
manifest's files are read once, hashed and held in memory. That includes the
payloads of locked flow extensions from `.flows/plugins`. Each case then gets a
fresh temporary copy written from those bytes, with read-only files and
directories, and the executor receives that copy's path. An edit to the
working tree during the evaluation cannot run under the judged version, and
neither can anything an earlier case did to its own copy. An in-memory spec
is cloned and frozen before it is hashed, and every case executes that clone. A local module the manifest cannot see,
such as a computed `import(\`./rules/${kind}.js\`)` or a file read at
runtime, is absent from the snapshot, so that run fails instead of executing
unjudged code. Write such modules as static imports.

Each local run also starts in the snapshot directory, so a relative read
(`readFileSync('./prompt.txt')`) resolves inside the sealed copy and fails
there if the file is not part of the version. Passing `cwd` to
`localFlowEvalExecutor` deliberately reintroduces the working tree.

A version cannot pin everything. **Evaluated code runs as the caller**, so it
can still reach anything the caller can:

- **`node_modules`** is linked into each copy, not copied. The lockfile in
  the manifest pins it. Containing hostile code needs a sandbox; the seal
  guarantees that the code which runs is the code the version names.

- **Absolute paths and other external state** such as the network are
  outside any version. This is the same as for a deployed flow.
- **Deterministic step commands** run in the daemon's working directory,
  which this evaluation does not choose when it attaches to an existing
  daemon.

`--baseline <report.json>` fails the gate on every case that passed in the
baseline and does not pass now. The baseline must have been produced from the
same suite and must cover exactly its cases.

Each case reports:

- its outcome (`pass`, `fail` or `error`) and the reasons it failed;
- wall-clock latency, cost and tokens, plus its run id and per-step status and
  duration when the executor supplies them;
- any caller-defined metrics.

## Executors

- **Local** (default): each case runs in its own `flows run` process against
  the daemon in `--data-dir`.
  - **Why one process per case:** an authored `.flow.ts` is loaded by
    `import()`, and an ES module is cached for the life of a process. A
    long-lived caller would otherwise keep executing the first version it
    loaded.
  - **Cost** is the sum of each step's own budget across the run and its
    authored child runs. The children are found through the root's
    `authored-steps` index, which also survives a failed body. A run's
    cumulative `budget_total` is never added, because an authored child starts
    from the flow's prior spend.
- **Cloud** (`--cloud`): each case runs as a hosted run and is waited on.
  The verdict and the completion detail come from the hosted run's stored
  report, so `declined` and `detailIncludes` mean the same thing as they do
  locally. Spend comes from the run's steps.
  - It needs `workflow:invoke:write` and `runs:read`.
  - **Cloud runs the entry file alone,** so a flow that imports local modules is
    refused before anything is submitted. Evaluate that flow locally.
  - Inside a Cloud step that means an injected workspace token, because a
    sandbox token reads only its own run.
- **Custom**: any `(request) => Promise<FlowEvalRun>`.

Memoization (`--reuse-from`) is never used. An evaluation must judge the
candidate's own step results.

## From inside a flow

From a step, as a command. The exit code is the verdict: 0 means pass, 1 means
fail, and 2 means the evaluation was refused.

```ts
const verdict = await f.run(
  'flows eval candidate.flow.ts --cases suite.json --data-dir .eval --report report.json',
  { onNonZero: 'record' },
);
if (!verdict.ok) return f.done('step_failed', { detail: verdict.output });
```

Or programmatically from any step script or authored body:

```ts
import { evaluateFlow, loadFlowEvalSuite, localFlowEvalExecutor } from '@relayflows/sdk';

const report = await evaluateFlow({
  flow: { path: 'candidate.flow.ts' },
  suite: await loadFlowEvalSuite('suite.json'),
  executor: localFlowEvalExecutor({ dataDir: '.eval' }),
  expectVersion: undefined, // optional: a pinned `sha256:` version
  baseline: undefined,      // optional: a prior report (parsed JSON)
  scorers: [{ name: 'quality', score: run => ({ value: 1, pass: true }) }],
});
if (!report.gate.pass) { /* do not deploy */ }
```

Run the evaluation's cases on their own data dir (`.eval` above), not on the
daemon hosting the gate run.

## Not covered here

- **Deploying after a pass is out of scope.** `deployToCloud` still requires an
  interactive `cli:auth` session (see [CLOUD.md](CLOUD.md)).
- **The post-merge trigger is out of scope.**
