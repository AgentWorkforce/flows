Shakedown flows — 2026-09-10 v2 launch prep

These are the six canonical scenarios the launch-prep shakedown ran against
`flows run`, extracted from `evidence/shakedown-0910/flow-sources.md` on branch
`shakedown/v2-launch-0910`. Their run transcripts live under
`evidence/shakedown-0910/*.txt` on that branch (drafted at PR #281).

Scenario map:

- `hello-world.flow.yaml` — pure deterministic; no external deps. Baseline
  that the CLI's happy path works.
- `agent-inline.flow.yaml` — inline `agents: { drafter: { cli, model } }`.
  Verifies #263: named-agent inline models work without a `flows.json` in
  the current or any ancestor directory.
- `deep-cwd.flow.yaml` — a deterministic flow to run from a working
  directory deep enough to push the daemon socket past macOS's SUN_LEN.
  Verifies #262: the hashed-under-tmp derivation.
- `chained.flow.yaml` — the flagship `llm → agent → deterministic` shape,
  with typed JSON output. **Currently blocked**: no local `llm` worker
  path (#273) and no declarative upstream-output binding (#275).
- `error-path.flow.yaml` — deliberately misspells a CLI to exercise the
  refusal shape. Sibling `error-dependency.flow.yaml` names a nonexistent
  `dependsOn` step.
- `observer.flow.yaml` — a small run intended to be paired with a live
  `RELAYCAST_WORKSPACE_KEY` so `flows run` mints an observer URL and prints
  it on stdout. Verifies #269 / #286.

Supplemental variants (agent-codex, chained-codex, chained-llm.flow.ts,
binding, etc.) remain snapshotted at
`evidence/shakedown-0910/flow-sources.md` on the shakedown branch rather
than promoted into this directory: they are exploratory shape-tests, not
canonical scenarios. Promote one if it becomes a first-class example.
