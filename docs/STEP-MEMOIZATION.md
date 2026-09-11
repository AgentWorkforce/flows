# Reusing steps after a spec edit

Give the flow a stable `name`, fix the failed step, then run:

```sh
flows run --reuse-from <prior-run-id> flow.yaml
```

The new run has its own journal and run id. Before starting each runnable
step, the kernel looks for a successful prior `step.completed` with the same
`(step_spec_hash, input_hash)`. A match appends a fresh completion carrying the
original output, verification, end pins and effect references, plus
`reused_from: { run_id, step_id, seq }`. It does not dispatch a worker or run a
command. Reuse charges zero additional budget. The original journal is opened
read-only and its entries remain unchanged.

The plain-text completion report includes:

```text
REUSE from <prior-run-id>: 25 reused, 1 executed
```

JSON reports include `reuse: { fromRunId, reusedSteps, executedSteps }`.
Counts come from the new journal; executed steps include failed executions
and count each step once, regardless of retries. A parked run reports the
facts recorded so far.

## Hash contract

`step_spec_hash` is SHA-256 of the canonical, default-materialized kernel
step spec, including its id, dependencies, verification, retry policy and
input bindings. `input_hash` hashes the actual named JSON values selected by
those bindings from successful upstream completions. No bindings means `{}`.
Selectors which do not resolve follow the ordinary typed failure path and
cannot produce a cache hit. Failed attempts may carry the hash of `null` for
unresolved input, but failed completions are always ineligible for reuse.

Canonical JSON recursively sorts object keys by UTF-16 order, preserves array
order and emits no whitespace. Floating-point values use ECMAScript spelling.
Exact kernel integers retain their decimal representation rather than rounding
through a floating-point conversion. The SDK's existing `canonicalize` and `specHash` implement the same contract;
shared input and step corpora in `testdata/canonical/` pin the two languages.
The existing flow-level spec hash is unchanged.

Dependencies determine when a step is eligible to run. Only explicit input
bindings contribute upstream values to `input_hash`; ambient files, environment
variables and external service state are not implicit inputs. Reuse explicitly
accepts the prior recorded outcome, including any recorded external effects.
Bind values that should invalidate downstream reuse as step inputs.

## Durability and compatibility

The scheduler retains dependency ordering, parallel surface exclusions,
cancellation and failure handling. Only a step's first attempt can be reused;
retries retain their existing semantics. Eligible source completions are
snapshotted into additive `run.spawned.reuse_candidates`, alongside
`reuse_from_run_id`, before execution begins. Resume reads this durable
snapshot even if the source later disappears or receives more completions.

The hash and provenance fields on `step.completed` are optional for readers.
Old entries without hashes are misses; failed completions are never reused.
New fields do not change the journal version or require older SDKs to change.

This flag applies to local YAML/JSON spec runs. Dynamic TypeScript flow bodies
and `--cloud` do not use this kernel spec walker and refuse the flag. Unnamed
flows cannot establish a stable cross-spec identity and also refuse reuse.

| Diagnostic | Exit | Meaning |
| --- | --- | --- |
| `reuse_spec_mismatch` | 2 | Source and requested flow must have the same name. |
| `reuse_run_not_found` | 2 | Source run id does not exist in the daemon data directory. |
| `reuse_journal_read_failed` | 1 | Source read failed; its outcome is unknown. |

`flows resume` keeps its existing same-run behavior. LSP reuse hints (L2),
`flows replay` integration and named data gates (P) remain follow-ups.
