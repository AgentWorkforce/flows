# Review-swarm trust boundary

The review swarm is a merge gate. Its wrapper,
`.github/workflows/review-swarm.yml`, selects the review definition, launches
the lenses, and enforces their verdict. A candidate must not be able to edit
that wrapper or the scripts that judge its change. This is RFC-0001 §2 rule 4
and settled decision 6 (also the `AGENTS.md` rule not to edit a gate that judges
your work).

`review-swarm-wrapper-guard.yml` is a `pull_request_target` workflow. GitHub
reads the workflow from the pull request base, and its checkout pins the guard
script to `github.event.pull_request.base.sha`. The guard rejects any file
entry whose `filename` or `previous_filename` is
`.github/workflows/review-swarm.yml`; checking both fields is required to catch
an attempted rename. The protected set is intentionally a single constant in
`swarm-wrapper-guard.sh`: the wrapper and guard workflow,
`swarm-wrapper-guard.sh`, the gate/definition helpers and tests, the diagnostic
helper and test, the prepare/post/verdict helpers, and the wrapper/workflow
contract tests. An intentional control-plane rename must update that constant
and its tests in the same base-owned change. `workflows/review-swarm.yaml` is
deliberately outside this set: it is the candidate review definition, validated
by the trusted definition gate; the base-owned definition is what the trusted
workflow executes. No candidate path is checked out or executed by
`pull_request_target`.

The exact protected paths are:

```text
.github/workflows/review-swarm.yml
.github/workflows/review-swarm-wrapper-guard.yml
.github/workflows/scripts/swarm-wrapper-guard.sh
.github/workflows/scripts/swarm-gate.test.sh
.github/workflows/scripts/swarm-definition.sh
.github/workflows/scripts/swarm-definition.test.sh
.github/workflows/scripts/swarm-status-diagnostic.sh
.github/workflows/scripts/swarm-status-diagnostic.test.sh
.github/workflows/scripts/swarm-prepare.sh
.github/workflows/scripts/swarm-post.sh
.github/workflows/scripts/swarm-verdict.sh
.github/workflows/scripts/swarm-wrapper-guard.test.sh
.github/workflows/scripts/review-swarm-workflow.test.sh
```

The main review workflow checks out the candidate in `pr-head` and the trusted
definition/scripts in `gate-files` at the immutable PR base SHA. The wait step
runs from `pr-head`, so `../gate-files/...` resolves to the trusted helper. A
preflight checks that the helper is executable and syntactically valid before a
cloud run starts; the wait step repeats the check so a checkout regression is
visible even when the poll itself is running with `set +e`.

Because the wrapper guard deliberately rejects every candidate touching
`review-swarm.yml`, the sparse-checkout/preflight correction is a base-owned
bootstrap prerequisite. A replacement PR carrying that correction will
correctly fail the guard until a human updates the base; the live review swarm
can only prove the full stack on the next candidate after that update.

`swarm-status-diagnostic.sh` is observability-only. It supports the structured
Cloud shape `{ "failure": { "phase": "...", "code": "..." } }` with bounded
identifier tokens and retains the legacy `.result.error` / `.error` text path,
indenting every line before it reaches logs or the step summary. Empty,
malformed, unsupported, and summary-unavailable inputs produce fixed safe text
and exit zero; `review-swarm.yml` separately fails on a non-completed swarm.
Malformed payloads are never echoed because they may contain provider or
agent-controlled secrets.

Run the deterministic checks from this checkout:

```bash
bash .github/workflows/scripts/swarm-status-diagnostic.test.sh
bash .github/workflows/scripts/swarm-wrapper-guard.test.sh
bash .github/workflows/scripts/review-swarm-workflow.test.sh
```
