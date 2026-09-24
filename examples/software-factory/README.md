# software-factory

[![Deploy Flow](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/flows/deploy?flow=https%3A%2F%2Fgithub.com%2FAgentWorkforce%2Fflows%2Fblob%2Fmain%2Fexamples%2Fsoftware-factory%2Fsoftware-factory.flow.ts&on=linear%3Ateam%3DENG)

One click deploys this flow to [Agent Relay Cloud](https://agentrelay.com/cloud), running on every new Linear issue in team `ENG`.

A ticket becomes a pull request: implementation agent → deterministic tests →
adversarial review agent → PR opened for a human. The review verdict is a file
the agent must write (`review.passed`), and the tests run outside any agent, so
neither can be talked into a green result.

```sh
flows check examples/software-factory/software-factory.flow.ts
flows deploy examples/software-factory/software-factory.flow.ts \
  --repo acme/api --on linear:team=ENG --approver you
flows deployments
```

`--on` also takes `github:labels=agent`, `jira:project=OPS`, `shortcut:workspace=…`
or `slack:channel=#eng`. Each matching ticket launches one Cloud run in a fresh
`relayflow/software-factory-<id>` branch of `--repo`; a passing review opens a
PR. Review artifacts under `.relayflow/` must contain exactly one verdict:

- `review.passed` opens a ready PR after the hooks allow it.
- `review.blocked` opens a draft with findings and ends `step_failed` (exit 1).
- Non-empty `review.unverified` names the missing verification prerequisite.
  It opens a draft headed **NOT VERIFIED**, explicitly claims no defect, and
  ends `needs_human` (exit 3). Unlike pre-publication parking, this outcome
  leaves a pushed branch and an opened draft PR; completion detail says so.

Silence, contradictory verdicts, and an empty `review.unverified` stay BLOCKED.
Every draft verdict (including hook refusals) names the reviewed commit and says
it covers that commit only. A new head supersedes the verdict, but this terminating
flow does not edit old bodies/comments, re-review pushes, or mark drafts ready.

Draft bodies introduce a new machine-readable contract:
`<!-- relayflow-review verdict=blocked reviewed-head=<40-hex-sha> -->`.
The other verdict values are `unverified`, `post-review-blocked`, and
`merge-gate-blocked`. Exactly one marker is allowed before publication.
The intended first consumer is [the resident babysitter](../babysitter/README.md),
which is not yet ready for unattended deployment; a future shepherd can compare
the marker with the current PR head before amending a superseded verdict.


The pull-request title is the ticket title (whitespace-normalized and capped at
240 Unicode code points). GitHub inputs must carry `identifier: "#<number>"`;
the flow appends exactly one `Fixes #<number>` line and validates the final
title and body before it pushes the branch or opens the pull request.

Locally, from a checkout on a scratch branch:

```sh
GH_TOKEN=$(gh auth token) flows run examples/software-factory/software-factory.flow.ts --local-agent \
  --input '{"approver":"you","issue":{"source":"local","title":"Add a health endpoint","body":"GET /healthz returns 200","labels":[]}}'
```
