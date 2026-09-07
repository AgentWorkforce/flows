# Step memory, slice 1 (#220)

A step may declare `memory: {scope, query, budget}`. `scope` is `script` or
`agent`; `query` must contain non-whitespace text. The SDK budget uses
`maxTokensIn`, `maxTokensOut`, and `maxDollars`; the kernel uses
`max_tokens_in`, `max_tokens_out`, and `max_dollars`. Limits are optional
(an empty budget object is unbounded). Token limits are safe non-negative
JSON integers; dollars are non-negative decimal strings. Unknown fields,
explicit nulls, invalid scopes, and malformed limits fail closed.

The declaration applies to deterministic, llm, and agent steps. Scope is
recorded provider input; it does not change scheduling or identify a tenant.
The shared `testdata/step-memory` fixture pins both dialects and their hash.

Before executing or dispatching the first attempt, the daemon asks its
`MemoryProvider` for a pack and cost. The default `FixedMemoryProvider` returns
`{"text":"fixed memory pack","citations":[]}` with **synthetic** usage of
7 input tokens, 0 output tokens, and `"0.002"` dollars. This is a substrate
stub: there is no retrieval, relayhistory call, or claim about memory quality.

The daemon appends `memory.injected` with the consuming `step_id`, initial
`attempt`, and this payload:

```json
{
  "request": {
    "scope": "agent",
    "query": "previous lessons",
    "budget": {"max_tokens_in": 7, "max_dollars": "0.002"}
  },
  "provider": "fixed-slice-1",
  "pack": {"text": "fixed memory pack", "citations": []},
  "budget": {"tokens_in": 7, "tokens_out": 0, "dollars": "0.002"}
}
```

The journal transaction validates the declaration, active attempt, cost, and
one-fact-per-step rule before committing. Folding this fact adds its cost
once to run spend and retains it on the consuming step. Step completion
usage is execution usage only and excludes the already charged memory cost.
Decimal addition is exact at arbitrary decimal precision; token-total
overflow returns an error instead of saturating.

Only a committed pack reaches execution: deterministic commands receive its
JSON in `RELAYFLOW_MEMORY`; remote workers receive the full recorded payload
in `step.dispatch.memory`. The SDK agent worker passes the pack into the
instruction sent to its CLI or wrapper. A provider error completes the attempt
with `worker_error`; an over-budget pack uses `budget_exceeded`. Neither is
dispatched or charged. A journal append error propagates and releases a
reserved worker slot.

Crash recovery and semantic retries reuse the original pack without calling
the provider or charging it again. A crash before a successful append may
call the provider again: no injection existed yet. Epoch rollover carries
recorded packs automatically and requires the summary to preserve recorded
spend; folding a summary restores packs without another charge. Historical
entry removal remains future epoch-compaction work.

The acceptance test kills the real daemon after injection and before worker
completion, resumes through the CLI, and checks identical dispatch context,
one injection, and total usage of 20 input tokens, 5 output tokens, and
`"0.005"` (memory plus one worker completion). Separate tests disable the
provider during replay/resume and cover semantic retries, epoch rollover,
budget rejection, and journal rejection. Commands and captured output are
in [evidence/220/README.md](evidence/220/README.md).
