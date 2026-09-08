# Executive summary

Keep Relayflow’s durable step journal; use deterministic replay only for pure orchestration. Agent/LLM outputs, effects, artifacts, and spend are nondeterministic facts, not code to rerun.

# Landscape and best practices

Temporal reruns deterministic workflow code against event history; external work belongs in Activities, and incompatible changes require versioning [1]. Inngest instead injects persisted step results on recovery [2]; Restate applies this to LLM/tool calls [3]. Consensus: persist outcomes and make effects idempotent. “Exactly once” without provider cooperation is marketing.

# Recommended approach

Fold append-only entries into `RunState`; schedule only unfinished steps. Persist leases, pins, outputs, `completionReason`, budgets, and effect keys in per-run SQLite; compact live state into `epoch.summary` (`kernel/DESIGN.md:3-11,65-78,135-149,162-206`).

# Trade-offs and risks

Journals expose step boundaries and storage/atomicity costs; replay preserves natural control flow but imposes determinism and deployment constraints. Elect→perform→confirm can duplicate provider success after a pre-confirmation crash (`kernel/DESIGN.md:121-133`).

# What we can leverage

Reuse the Rust/rusqlite journal and pure state machine; DBOS/Inngest validate the pattern, but migration adds little.

# Open questions

Can every adapter enforce provider idempotency? What retention and resume-latency bounds pass crash injection?

# Sources

1. https://docs.temporal.io/workflow-definition — verified
2. https://www.inngest.com/docs/learn/how-functions-are-executed — verified
3. https://docs.restate.dev/ai/patterns/durable-agents — verified
