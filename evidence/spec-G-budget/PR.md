Title: feat(surface,sdk,kernel): budget header + spend attribution (SURFACE §2 rule 5)

The `budget:` header was declared in surface examples but never enforced. This
change accepts string and object headers, refuses invalid syntax and missing
model prices before execution, and records tokens, dollars, and elapsed attempt
time on every completion. Once completed spend crosses a limit, the kernel
preserves completed work and refuses the next start with `budget_exceeded`.

Parent issue: the lead will insert the issue link when opening this PR.

The SDK uses the frozen model-pricing table and integer microdollars; the kernel
keeps exact decimal accounting through replay. UTC day windows, total-token and
wallclock limits are supported. The internal authored executor carries journaled
spend between its existing per-step kernel runs. Legacy explicit envelopes keep
their worker-supplied price contract. See [the budget contract](docs/BUDGET.md).

Fixture: [budget-guarded.flow.yaml](testdata/budget-guarded.flow.yaml). Its
`measured` command completes; `guarded` never starts. Actual journal excerpt:

```json
{"entry_type":"step.completed","step_id":"measured","payload":{"completionReason":"success","spend":{"tokens_input":0,"tokens_output":0,"dollars":0,"wallclock_ms":19}}}
{"entry_type":"run.completed","payload":{"completionReason":"budget_exceeded"}}
```

Validation commands and complete captured output are in
[evidence/spec-G-budget](evidence/spec-G-budget/README.md). Kernel workspace,
surface tests, and focused SDK tests pass. Plain `npm test` remains blocked by
this host's missing Claude login for the existing live analyzer acceptance test;
that failure has not been skipped or weakened. A timing-sensitive existing
lease-wait test failed in one full run and passed in the subsequent focused run.
The two new exhaustive refusal scenarios were added with lead approval; the
existing assertion is unchanged.

The lead owns PR creation, CI verification, and bot review because GitHub
credentials on the worker return HTTP 401. Do not mark ready for merge until
those checks and the live analyzer acceptance requirement are satisfied.
