# Budget headers and spend

`budget` is optional. A flow may declare `"$0.10/run"`, `"$20/day"`, or
`{ tokens: 10000, dollars: 0.10, wallclock: "2m" }`. Objects default to a run
window. Tokens count input plus output; wallclock sums attempt durations from
journaled start to completion. Duration units are `ms`, `s`, `m`, `h`, and `d`.
Limits are non-negative; dollars support up to six decimal places.

A day is a UTC calendar day within a run. Completed spend resets for admission
at the next UTC day; unrelated runs do not share a global account. Header
syntax errors refuse as `budget_syntax_invalid`.

A missing price never refuses a run. What is and is not enforced:

- **Priced steps** (a model in the frozen table) journal exact dollars, and a
  crossed `maxDollars` stops the run as described below.
- **Unmetered steps** (under a dollar budget, an LLM/agent step with no model,
  or a model without a frozen price) warn as `budget_unmetered` at preflight
  and run. Their dollar cost is unknown, so they journal their tokens with
  `dollars_unmetered: true` and cannot cross `maxDollars`. Codex selects its
  own model, so a Codex step without a declared model is expected to be
  unmetered.
- **Tokens and wallclock** are enforced for every step, priced or not.

The project model allowlist (`flows.json` `models`) is a separate preflight
check and still refuses an unlisted model as `model_unknown`, before and
independent of pricing.

Every newly written `step.completed` includes:

```json
"spend": {
  "tokens_input": 1000,
  "tokens_output": 200,
  "dollars": 0.006,
  "wallclock_ms": 25
}
```

An unmetered step adds `"dollars_unmetered": true` to `spend` and to its
`budget`; its `dollars` then counts only metered cost (zero), a lower bound
rather than a measured amount. The flag is sticky on run totals
(`budget_total`, `budget_spent`) and is carried into a continuing run through
`budget.prior_spend`, so a run report can say its dollar total is incomplete
even when the unpriced step ran earlier in the flow. The key is omitted when
false, and readers must ignore it if they
do not know it. Journals written before this flag existed, including #421's
builds that journaled unpriced steps as `dollars: "0.000000"`, cannot be told
apart from metered zero-cost steps.

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
journaled costs into the next run's `budget.prior_spend`, including
`dollars_unmetered` once any carried charge was unmetered. The kernel
initializes the continuing run's `Budget` from that record field for field, so
an unpriced step early in a flow still makes every later step's cumulative
total say its dollars are incomplete instead of a measured zero. Its generated
terminal marker does not consume the author's step budget. This does not add a
durable TypeScript root or change that runner's existing resume contract.

`prior_spend` stays additive in one direction only, deliberately. It still
rejects unknown keys, and `dollars_unmetered` is omitted when false: a kernel
older than the key therefore sees an unchanged payload for every fully metered
flow, and refuses the spec outright only for a flow that really did carry
unknown cost — the one case where ignoring the key would silently under-report
the total. A kernel newer than the key reads a payload without it as metered,
which is what it meant before.

Raw Claude/Codex adapters request structured output to extract usage. A custom
wrapper may return an explicit result envelope after its execution handshake:

```json
{"protocol":"relayflows-agent-cli-v1-result","output":"answer","usage":{"input_tokens":1000,"output_tokens":200}}
```

A priced model with missing or malformed usage produces a journaled worker
error. An unpriced model's usage is optional: reported tokens are journaled
with `dollars_unmetered: true`, and a completion with no reported tokens is
still marked unmetered (with zero tokens). Workers never omit usage for an
unpriced step and never send `dollars` alongside `dollars_unmetered`; the kernel
rejects that combination at `step.complete` when the dollars are non-zero.
Legacy `maxTokensIn` / `maxTokensOut` / `maxDollars` envelopes keep their
worker-supplied pricing contract, including existing synthetic test models.
New surface headers carry `pricing: "frozen"` through compiled artifacts, so
checking a compiled flow reports the same `budget_unmetered` warnings (and no
refusal) as checking its source.

`testdata/budget-guarded.flow.yaml` is a local smoke using a zero-duration budget:
its first completed command exceeds the ceiling and its dependent command
never starts.
