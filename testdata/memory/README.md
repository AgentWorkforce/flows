# Minimal local script-memory example

This slice implements `f.memory.recall` and `f.memory.why` through ai-hist
0.4.1. Reads have no journal steps. `memory: { script: true }` is already part
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

- `learn` and journal effect record/confirm idempotency. ai-hist 0.4.1 exposes
  reads and tag writes, but no public trajectory writer. The authored executor
  also lacks a durable root run ID. `learn` explicitly refuses until both seams
  are available; no unjournaled write is substituted.
- Identity-scoped agent context injection. `memory.agent: true` explicitly
  refuses; it must not silently read script scope.
- CLI-only provider operation and automatic creation of a fresh database.
- Full static usage discovery, including aliases. Direct `.memory` use and
  declared headers probe before the body; aliased helpers probe at call time.
- Automatic trajectory import and the behavioural Gate 5 acceptance example.
- Cloud push and pair mode, per the original exclusions.

This is a read-only proof slice, not completion of Gate 5 or the full original
recall/why/learn acceptance matrix. The lead owns PR creation and CI review.
