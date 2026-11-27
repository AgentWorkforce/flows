# Minimal local script-memory example

This slice implements `f.memory.recall`, `f.memory.why`, and `f.memory.learn`
through ai-hist 0.63.1. Reads journal nothing. `learn` stages a compacted
trajectory file, appends the finding to the durable root run's
`memory-learn` stream, then renames the file into place at
`<db-dir>/flows-memory/<scope-hash>/.trajectories/compacted/<id>.json`; the
file cites the commit. ai-hist 0.63 retired its trajectories table and does
not ingest these files. The database is never modified. `recall` searches
history prompts and merges this scope's learned files. `why` reads those
files only. A resumed body re-running `learn` republishes from the commit instead of
journaling twice, and `learn` refuses (`memory_unjournaled`) without a root
run. `tests/memory-learn-live.test.ts` exercises it through the built CLI and
a real kernel. `memory: { script: true }` is already part
of the surface header contract and now works in the internal authored executor.

`seed.mjs` creates a new ai-hist 0.63 database with two script scopes and one
history prompt per scope. It does not write a decision trajectory: `why` reads
learned files, not the database. It never scans host history or uses the
cloud. Run it with Node after installing `packages/sdk`:

```sh
node testdata/memory/seed.mjs /tmp/flow-memory.db '<script-scope>'
```

The scope is produced by `scriptMemoryScope(flowPath, flowName)` in
`packages/sdk/src/authored-memory.ts`: SHA-256 of the absolute flow file path
and flow name, underneath `<flow-directory>/.relayflows/memory/scripts/`.
Seed history rows with that value as `project`. It is stable across runs, and
changes when the flow moves or is renamed. It is separate from identity-scoped
agent memory. The regression test
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

Set `AI_HIST_DB` to the seeded DB. The probe requires an existing SQLite file;
a missing DB is `memory_unreachable`. `search` on a missing path returns no
rows and does not create the file, so the probe checks the path before searching.

## Deferred acceptance work

- Identity-scoped agent context injection. `memory.agent: true` explicitly
  refuses; it must not silently read script scope.
- CLI-only provider operation and automatic creation of a fresh database.
- Full static usage discovery, including aliases. Direct `.memory` use and
  declared headers probe before the body; aliased helpers probe at call time.
- Automatic trajectory import and the behavioural Gate 5 acceptance example.
- Cloud push and pair mode, per the original exclusions.

This is a local slice, not completion of Gate 5 or the full original
recall/why/learn acceptance matrix. The lead owns PR creation and CI review.
