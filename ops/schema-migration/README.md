# The legacy workflow schema is a fork, not a stale file

`ops/RUNTIME-STATUS.md` records that the local SDK "refuses its old
`swarm`/`workflows` schema before execution". That is true, and it reads like a
migration chore. It is not. **Two runtimes consume these files and they speak
different schema versions.**

## The evidence

The local SDK refuses the 1.0 schema outright:

Literal, captured 2026-09-08. The script emits one JSON diagnostic on stderr
and exits 2; earlier revisions of this file reformatted it into a readable
list, which made a paraphrase look like a transcript.

```
$ node scripts/run-local-workflow.mjs workflows/drive.yaml; echo "rc=$?"
{"severity":"refusal","kind":"invalid_spec","message":"Relayflow spec is invalid: spec: unknown key \"swarm\" (expected one of version | name | description | cli | agents | triggers | steps | budget); spec: unknown key \"workflows\" (expected one of version | name | description | cli | agents | triggers | steps | budget); spec.version: unsupported version \"1.0\" (expected \"0.1.0\"); spec.agents: expected a map of named { cli, model } declarations; spec.steps: expected a non-empty array","errors":["spec: unknown key \"swarm\" (expected one of version | name | description | cli | agents | triggers | steps | budget)","spec: unknown key \"workflows\" (expected one of version | name | description | cli | agents | triggers | steps | budget)","spec.version: unsupported version \"1.0\" (expected \"0.1.0\")","spec.agents: expected a map of named { cli, model } declarations","spec.steps: expected a non-empty array"]}
rc=2
```

Cloud accepts it. On 2026-09-07 the review gate ran
`agent-relay cloud run workflows/review-swarm.yaml --sync-code --json` against
the unmodified 1.0 file; it returned run `04da7e48-87ec-4c7a-a1ee-22fd482e1cd1`
and was given sandbox `b5f3b344-64cc-434d-97f8-f5da71ba4517`. It failed later,
on Daytona CPU quota — not on schema.

## Why this matters before anyone migrates

Three of the seven legacy files are consumed by cloud **right now**:

| File | Consumer |
|---|---|
| `workflows/review-swarm.yaml` | `.github/workflows/review-swarm.yml:145`, every PR |
| `workflows/watchdog.yaml` | live cloud schedule `flows-watchdog`, cron `0 8 * * *`, active |
| `workflows/drive.yaml` | registered via `agent-relay cloud schedule` (see `ops/AUTONOMY.md`) |

Migrating those to 0.1.0 makes them parse locally and may make them
unrunnable in cloud, which would take out the review gate and the watchdog
together. **Nothing here migrates a live file.** The question that has to be
answered first is simple and I could not answer it from this machine: *does
cloud accept 0.1.0?*

## What this directory provides

`migrate-legacy-workflow.py` converts one legacy file and **refuses rather than
guesses**. A migration that silently drops a field is worse than one that
fails: the flow runs, looks fine, and means something else. Verified against
the real SDK — all seven files convert and compile.

The conversion is not lossless, and the losses are recorded as comments in
every output file rather than discovered later as bugs:

- `swarm: {pattern, channel, timeoutMs}` — 0.1.0 has no run-level slot.
- agent `preset` — persona surface (RFC-0001 decision 9), not flow spec.
- agent `timeoutMs` — 0.1.0 bounds deterministic steps only.
- a named agent reference becomes the step's `cli`. 0.1.0 requires `model` in a
  named declaration and the legacy schema never carried one; rather than invent
  a model, the agent's `cli` is carried onto the step. Verified: an agent step
  with `cli` and no agents map compiles; an agents map with `cli` and no
  `model` is refused.

Structural changes that are lossless: `version` 1.0 → 0.1.0, step `name` → `id`,
agent step `task` → `instruction`, and `workflows[0].steps` lifted to top level.
Every legacy file in this repo declares exactly one workflow, so that lift is a
lift and not a split — the script refuses a multi-workflow file rather than
guessing how to divide it.
