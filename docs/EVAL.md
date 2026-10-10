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
  `step_failed`, `budget_exceeded`, `canceled`, `needs_human`, `refused`.
- **`expect.detailIncludes` / `detailMatches`** check the run's completion
  detail, which is what the body passed to `f.done(reason, { detail })`.
- **An unknown cost never passes a cost ceiling.**
- **`minPassRate` defaults to 1.** An *errored* case was never judged, so it
  fails the gate whatever the pass rate is.
- **Unknown fields are refused.** A typo in `expect` cannot silently weaken a gate.

## What a report pins

Every report records:

- **`flow.version`**: the sha256 of the flow source bytes;
- **`suite.sha256`**: the sha256 of the suite's canonical JSON.

`--expect-version` (`expectVersion`) refuses to evaluate any flow bytes other
than the pinned ones. `expectSuiteSha256` refuses any other suite.
`--baseline <report.json>` fails the gate on every case that passed in the
baseline and does not pass now. The baseline must have been produced from the
same suite.

Each case reports:

- its outcome (`pass`, `fail` or `error`) and the reasons it failed;
- its run id, wall-clock latency, cost and tokens, per-step status and duration;
- any caller-defined metrics.

## Executors

- **Local** (default): each case runs in its own `flows run` process against
  the daemon in `--data-dir`.
  - **Why one process per case:** an authored `.flow.ts` is loaded by
    `import()`, and an ES module is cached for the life of a process. A
    long-lived caller would otherwise keep executing the first version it
    loaded.
  - **Cost** is read from the run's journal and the journals of its authored
    child runs.
- **Cloud** (`--cloud`): each case runs as a hosted run and is waited on.
  Spend comes from the run's steps.
  - It needs `workflow:invoke:write` and `runs:read`.
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
  expectVersion,            // optional pin
  baseline,                 // optional prior report
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
