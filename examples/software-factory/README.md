# software-factory

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
