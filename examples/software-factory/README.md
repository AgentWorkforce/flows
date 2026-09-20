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
PR, a blocked one opens a draft PR carrying the findings and ends `step_failed`.

Locally, from a checkout on a scratch branch:

```sh
GH_TOKEN=$(gh auth token) flows run examples/software-factory/software-factory.flow.ts --local-agent \
  --input '{"approver":"you","issue":{"source":"local","title":"Add a health endpoint","body":"GET /healthz returns 200","labels":[]}}'
```
