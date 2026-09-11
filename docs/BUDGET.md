# Budget headers and spend

`budget` is optional. A flow may declare `"$0.10/run"`, `"$20/day"`, or
`{ tokens: 10000, dollars: 0.10, wallclock: "2m" }`. Objects default to a run
window. Tokens count input plus output; wallclock sums attempt durations from
journaled start to completion. Duration units are `ms`, `s`, `m`, `h`, and `d`.
Limits are non-negative; dollars support up to six decimal places.

A day is a UTC calendar day within a run. Completed spend resets for admission
at the next UTC day; unrelated runs do not share a global account. Header
syntax errors refuse as `budget_syntax_invalid`. Declared models without a
frozen price refuse as `budget_missing_price`; dollar budgets also require a
model on each worker step. Existing project model allowlist checks still apply.

Every newly written `step.completed` includes:

```json
"spend": {
  "tokens_input": 1000,
  "tokens_output": 200,
  "dollars": 0.006,
  "wallclock_ms": 25
}
```

The frozen table in `packages/sdk/src/model-pricing.ts` quotes dollars per
million tokens. Workers compute integer microdollars:
`inputTokens * inputPrice + outputTokens * outputPrice`. The existing `budget`
field retains exact decimal dollars; only the journal's `spend.dollars` becomes
a JSON number. Memory-injected costs retain their existing single charge.
Deterministic steps have zero model tokens and dollars, with measured duration.

The kernel checks accumulated spend before each new attempt. Equality is
permitted. Crossing a limit keeps that completion valid and refuses the next
start with `run.completed.completionReason: "budget_exceeded"`. Running peers
may finish; no new peers start. A final successful step may cross a limit and
still complete its run successfully. Replay reconstructs accounting from the
journal, including retries and prior epochs.

The internal TypeScript executor currently lowers each authored step to its
own kernel run. For budgeted flows it serializes admission and carries exact
journaled costs into the next run's `budget.prior_spend`. Its generated terminal
marker does not consume the author's step budget. This does not add a durable
TypeScript root or change that runner's existing resume contract.

Raw Claude/Codex adapters request structured output to extract usage. A custom
wrapper may return an explicit result envelope after its execution handshake:

```json
{"protocol":"relayflows-agent-cli-v1-result","output":"answer","usage":{"input_tokens":1000,"output_tokens":200}}
```

A priced model with missing or malformed usage produces a journaled worker
error. Legacy `maxTokensIn` / `maxTokensOut` / `maxDollars` envelopes keep their
worker-supplied pricing contract, including existing synthetic test models.
New surface headers carry `pricing: "frozen"` through compiled artifacts so
checking a compiled flow preserves the same missing-price refusal.

`testdata/budget-guarded.flow.yaml` is a local smoke using a zero-duration budget:
its first completed command exceeds the ceiling and its dependent command
never starts.
