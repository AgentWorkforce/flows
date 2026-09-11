# YAML helper verbs

Helpers compile into ordinary agent steps that execute journal-backed effects
through `@relayfile/relay-helpers`. Slack uses the same writeback path as
`f.slack`. No provider step type is added to the kernel.

```yaml
version: 0.1.0
steps:
  - id: notify
    slack:
      post:
        channel: "#test"
        text: hi
  - id: ticket
    dependsOn: [notify]
    linear:
      createIssue:
        teamId: engineering
        title: Follow up
```

Each step has an `id` and exactly one provider containing exactly one verb.
Optional step fields are `dependsOn`, `maxIterations`, `verification`, and
`output`. Arguments are literal JSON-compatible data; templates and dynamic
argument bindings are not supported. Unknown fields, verbs, and malformed
arguments fail compilation. `YamlFlowSpec` and `YamlHelperStepSpec` describe
the authoring shapes; `compileSpec` returns the normalized `FlowSpec`.

Supported verbs:

| Provider | Verbs |
| --- | --- |
| Slack | `post`, `dm`, `reply`, `react` |
| GitHub | `comment`, `createIssue`, `createPullRequest`, `closePullRequest` |
| Linear | `comment`, `createIssue`, `updateIssue` |

Single-object client arguments appear directly under the verb. Slack's
positional arguments become named fields (`channel`, `text`, `opts`, etc.).
GitHub `comment` takes `{target: {owner, repo, number}, body}`; Linear `comment`
takes `{issueId, body}`, and `updateIssue` takes `{issueId, args}`.

Configure a relayfile mount containing the provider directory using the same
mount environment variables as TS Slack helpers (`RELAYFILE_MOUNT_PATH`,
`WORKSPACE_ROOT`, `WORKFORCE_SANDBOX_ROOT`, `RELAYFILE_MOUNT_ROOT`, or
`RELAYFILE_ROOT`). `flows check` refuses missing mounts. To run locally:

```sh
flows run notify.yaml --local-agent
```

An attached SDK `AgentWorker` can also execute these steps; it must have a
`dataDir` for durable receipts. Completion output contains the effect call,
its stable idempotency key, and `receipt`. As with TS Slack, receipts are saved
before effect confirmation, allowing unfinished attempts to recover without
repeating a confirmed provider write. Keep the worker's data directory across
restarts.
