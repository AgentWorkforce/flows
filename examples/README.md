# Example gallery status

The three entries below are the requested WS-13 gallery scope. They are
advanced examples, not a promise that every surface feature is executable.
For a working local starting point, use the [small agent starter](../README.md)
([recorded run](../docs/evidence/ws13/agent-run.txt)).

| Example | Status | Observed result | Elapsed |
|---|---|---|---:|
| [dependency-upgrade-bot](dependency-upgrade-bot/) | **BLOCKED** | SDK refuses unsupported `budget` header before entering the body; exit 2 | [1.224s](../docs/evidence/ws13/followup/gallery-dependency-upgrade-bot.txt) |
| [pr-review-pipeline](pr-review-pipeline/) | **BLOCKED** | SDK refuses unsupported `budget` header before entering the body; exit 2 | [0.252s](../docs/evidence/ws13/followup/gallery-pr-review-pipeline.txt) |
| [research](research/) | **RETRY IN PROGRESS** | Preflight passed; first run failed at the supplied 3-minute step limit. Retrying with the documented default budget | [217.375s for the first attempt](../docs/evidence/ws13/followup/gallery-research.txt) |

Each link contains the literal command, captured output, exit code and timing.
These are individual runs from a separate clone on an authenticated macOS
host, against the packed candidate CLI. Research uses its documented source
shim. These timings are not clean-machine measurements.

**Dependency-upgrade-bot and pr-review-pipeline need the SDK/kernel capability
owner.** Their authored budgets are currently rejected. Their postfix artifact
gates and workspace permission declarations also require runtime support.
Removing those requirements would weaken what the examples promise; this
branch leaves them intact. The local agent worker handles stream-only steps
and cannot supply workspace isolation.

**Research now prints provider preflight activity.** Each CLI/model probe names
its timeout on stderr, while stdout remains the final structured result. All
four model probes passed in the first follow-up run; the three-minute limit
then expired during research. That failure is not evidence of missing provider
authentication or an unsupported model. The earlier outer timeout is retained
in the [historical evidence](../docs/evidence/ws13/gallery-research.txt).
