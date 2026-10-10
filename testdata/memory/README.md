# Minimal local script-memory example

This slice implements `f.memory.recall`, `f.memory.why`, and `f.memory.learn`
through ai-hist 0.4.1. None of them journal a step. `memory: { script: true }` is already part
of the surface header contract and now works in the internal authored executor.

`seed.mjs` creates a new deterministic SQLite database with two script scopes,
one prompt and one decision trajectory per scope. It never scans host history
or uses the cloud. Run it with Node after installing `packages/sdk`:

```sh
node testdata/memory/seed.mjs /tmp/flow-memory.db '<script-scope>'
```

The scope is produced by `scriptMemoryScope(flowPath, flowName)` in
`packages/sdk/src/authored-memory.ts`: SHA-256 of the absolute flow file path
and flow name, underneath `<flow-directory>/.relayflows/memory/scripts/`.
Seed/import script entries with that value as history `project` and trajectory
`project_id`. It is stable across runs, and changes when the flow moves or is
renamed. It is separate from identity-scoped agent memory. The regression test
computes it and seeds a temporary database automatically:

```sh
cd packages/sdk
./node_modules/.bin/vitest run tests/f-memory.test.ts
```

The test runs this body through `executeAuthoredFlow` with a fake journal and
asserts that only the final completion marker is journaled:

```ts
flow('memory-example', { memory: { script: true } }, async f => {
  const history = await f.memory.recall('retry safely');
  const decisions = await f.memory.why('retry safely');
  f.done('success');
});
```

Set `AI_HIST_DB` to the seeded DB. The adapter uses `fallback: 'error'` and
requires an existing SQLite file; a missing DB is `memory_unreachable`, rather
than ai-hist's automatic scan of unrelated local JSONL history.

## Deferred acceptance work

- Journaled `learn` effects. ai-hist 0.4.1 has no public trajectory writer,
  so `learn` writes the finding twice under the script scope: a compacted
  trajectory file at `<scope>/.trajectories/compacted/<id>.json` (the format
  `ai-hist sync` ingests), and the matching `trajectories`/`history` rows in the
  ai-hist database (atomic file replace) so the next run recalls it without a
  sync. The id is a hash of scope and finding, so a resumed body re-running
  `learn`, or a later run learning the same thing, upserts one record. Writes
  are serialized in-process and across flows processes by
  `<db>.flows-memory.lock` (stale once its owner process is gone, or after 5
  minutes), keep the database's file mode,
  migrate a missing `history.git_branch`, and roll back the trajectory file if
  the database replace fails. It is still not a journaled effect, and
  `ai-hist sync` does not take the lock, so a concurrent sync can race the row
  write; the trajectory file survives and the sync re-ingests it.
- Identity-scoped agent context injection. `memory.agent: true` explicitly
  refuses; it must not silently read script scope.
- CLI-only provider operation and automatic creation of a fresh database.
- Full static usage discovery, including aliases. Direct `.memory` use and
  declared headers probe before the body; aliased helpers probe at call time.
- Automatic trajectory import and the behavioural Gate 5 acceptance example.
- Cloud push and pair mode, per the original exclusions.

This is a local proof slice, not completion of Gate 5 or the full original
recall/why/learn acceptance matrix. The lead owns PR creation and CI review.
