# Examples

One-click deploy to [Agent Relay Cloud](https://agentrelay.com/cloud) — the wizard reads the
flow straight from this repo, shows its steps, and asks you to connect whatever it needs:

| Flow | Trigger | Deploy |
|---|---|---|
| [pr-review-pipeline](pr-review-pipeline/) — three review lenses in parallel, then a consensus pass | every `pull_request` | [![Deploy Flow](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/flows/deploy?flow=https%3A%2F%2Fgithub.com%2FAgentWorkforce%2Fflows%2Fblob%2Fmain%2Fexamples%2Fpr-review-pipeline%2Fpr-review-pipeline.flow.ts&on=github%3Aevents%3Dpull_request) |
| [software-factory](software-factory/) — implement → test → adversarial review → open a PR | every Linear issue in team `ENG` | [![Deploy Flow](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/flows/deploy?flow=https%3A%2F%2Fgithub.com%2FAgentWorkforce%2Fflows%2Fblob%2Fmain%2Fexamples%2Fsoftware-factory%2Fsoftware-factory.flow.ts&on=linear%3Ateam%3DENG) |
| [stale-issues](stale-issues/) — triage every open issue, post a Slack digest | schedule (`flows schedule … --cron "0 9 * * 1-5"`) | — |

Or from a checkout: `flows deploy <flow.ts> --repo <owner/name> --on <provider[:k=v]> --approver <you>`.

## Gallery status

**3 of 4 gallery entries pass; one is blocked.** The blocked entry fails
explicitly before its body executes. The entries below are
advanced examples, not a promise that every surface feature is executable.
For a working local starting point, use the [small agent starter](../README.md)
([recorded run](../docs/evidence/ws13/agent-run.txt)).

| Example | Status | Observed result | Elapsed |
|---|---|---|---:|
| [dependency-upgrade-bot](dependency-upgrade-bot/) | **BLOCKED** | SDK refuses unsupported `budget` header before entering the body; exit 2 | [5.138s](../docs/evidence/ws13/review/gallery/gallery-dependency-upgrade-bot.txt) |
| [pr-review-pipeline](pr-review-pipeline/) | **PASS (local, real agents)** | Fresh directory, `@relayflows/surface@2.0.17`, `flows.json` = `{"cli":"claude"}`: 9 steps completed, three parallel lens agents each gated on their journaled `review/<lens>.json`, consensus predicate gate passed, exit 0, `completionReason: success`. Needed the SDK fix that stops a `flows.json` without `models` from acting as an empty model allowlist. | 74s |
| [pr-reviewer](pr-reviewer/) | **PASS (local, stand-ins)** | The wepost PR reviewer as a v2 flow: 17 journaled steps end to end through the real kernel with a wrapper agent and an API shim; happy, red-tests and draft paths proven. See its README. | — |
| [research](research/) | **PASS** | All model probes passed; three lane reports and synthesis produced; exit 0, `completionReason: synthesized` | [690.935s](../docs/evidence/ws13/followup/default-budget/gallery-research.txt) |

**Correction:** the previously listed 0.138s and 0.143s captures used a stale
launcher and returned `invalid_invocation`. They did not establish budget
refusals. The current values above come from a fresh,
[verified candidate install](../docs/evidence/ws13/review/installed-identity.txt).

Each link contains the literal command, captured output, exit code and timing.
These are individual runs from a separate clone on an authenticated macOS
host, against the packed candidate CLI. Research uses its documented source
shim. These timings are not clean-machine measurements.

**Dependency-upgrade-bot still needs the SDK/kernel capability owner** for
its workspace permission declarations: the local agent worker handles
stream-only steps and cannot supply workspace isolation, and a
`"...: readwrite"` annotation is refused because nothing enforces it.
Budget headers and postfix artifact gates are supported; pr-review-pipeline
uses them without workspace scoping.

**Research now prints provider preflight activity.** Each CLI/model probe names
its timeout on stderr, while stdout remains the final structured result.
The run with the documented default budget completed in 690.935s; its
[three reports and synthesis](../docs/evidence/ws13/followup/default-budget/reports/)
are captured with [artifact hashes](../docs/evidence/ws13/followup/default-budget/artifacts.json).
The first follow-up's shorter three-minute step limit expired after 217.375s
([captured failure](../docs/evidence/ws13/followup/gallery-research.txt)). That
attempt is not evidence of missing authentication or an unsupported model.
