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
or `slack:channel=#eng`, and `linear` accepts `team`, `project`, `labels` and
`contains` (`linear:team=TECH,labels=agent`); `team` matches the Linear team
name or its key, so `team=Engineering` and `team=TECH` are the same filter. The
deploy page shows every filter as an editable field — the badge's `team=ENG` is
just the starting value.

Each matching ticket launches one Cloud run in a fresh
`relayflow/software-factory-<id>` branch of `--repo`; a passing review opens a
PR, a blocked one opens a draft PR carrying the findings and ends `step_failed`.
The pull-request title is the ticket title (whitespace-normalized and capped at
240 Unicode code points). GitHub inputs must carry `identifier: "#<number>"`;
the flow appends exactly one `Fixes #<number>` line and validates the final
title and body before it pushes the branch or opens the pull request. A Linear
identifier (`TECH-42`) gets the same treatment — `Fixes TECH-42` is what
Linear's GitHub integration reads to link the pull request to the issue and
move it when the PR merges.

Locally, from a checkout on a scratch branch:

```sh
GH_TOKEN=$(gh auth token) flows run examples/software-factory/software-factory.flow.ts --local-agent \
  --input '{"approver":"you","issue":{"source":"local","title":"Add a health endpoint","body":"GET /healthz returns 200","labels":[]}}'
```
