# Example gallery status

**1 of 3 requested entries passed.** The two blocked entries fail explicitly
before their bodies execute. The entries below are
advanced examples, not a promise that every surface feature is executable.
For a working local starting point, use the [small agent starter](../README.md)
([recorded run](../docs/evidence/ws13/agent-run.txt)).

| Example | Status | Observed result | Elapsed |
|---|---|---|---:|
| [dependency-upgrade-bot](dependency-upgrade-bot/) | **BLOCKED** | SDK refuses unsupported `budget` header before entering the body; exit 2 | [5.138s](../docs/evidence/ws13/review/gallery/gallery-dependency-upgrade-bot.txt) |
| [pr-review-pipeline](pr-review-pipeline/) | **BLOCKED** | SDK refuses unsupported `budget` header before entering the body; exit 2 | [3.539s](../docs/evidence/ws13/review/gallery/gallery-pr-review-pipeline.txt) |
| [research](research/) | **PASS** | All model probes passed; three lane reports and synthesis produced; exit 0, `completionReason: synthesized` | [690.935s](../docs/evidence/ws13/followup/default-budget/gallery-research.txt) |

**Correction:** the previously listed 0.138s and 0.143s captures used a stale
launcher and returned `invalid_invocation`. They did not establish budget
refusals. The current values above come from a fresh,
[verified candidate install](../docs/evidence/ws13/review/installed-identity.txt).

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
its timeout on stderr, while stdout remains the final structured result.
The run with the documented default budget completed in 690.935s; its
[three reports and synthesis](../docs/evidence/ws13/followup/default-budget/reports/)
are captured with [artifact hashes](../docs/evidence/ws13/followup/default-budget/artifacts.json).
The first follow-up's shorter three-minute step limit expired after 217.375s
([captured failure](../docs/evidence/ws13/followup/gallery-research.txt)). That
attempt is not evidence of missing authentication or an unsupported model.
