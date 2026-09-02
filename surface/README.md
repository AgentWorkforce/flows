# `@relayflows/surface`

The TypeScript authoring contract described by `docs/SURFACE.md`.

The package defines flows and the context that a journal-backed runtime
injects. A flow handle retains an immutable header and body behind the
`@relayflows/surface/runtime` bridge used by `@relayflows/sdk`; the public
handle remains the frozen `{ name }` authoring value. This package never
constructs a context, executes a body on its own, or contacts the kernel.
Those responsibilities stay behind `@relayflows/sdk` and the journal protocol.
The SDK's initial executor supports the deliberately small executable slice:
an empty header, awaited plain `f.run(...)` calls, and one
`f.done("success")`. It compiles each command and a terminal success marker to
deterministic specs, submits them through the existing journal client, and
reads results from `step.completed`. Other headers, verbs, postfix gates, and
completion lowering refuse rather than running outside the journal.

This is currently an in-repository foundation, not a registry-published
package. The repository's `flows run` command can execute a directly authored
`.flow.ts` with required JSON input. Resident trigger handlers (`flow.on(...)`)
are gate-2 work and are not yet part of this package.

The repository pins Bun through `surface/bun.lock`. From a fresh checkout:

```sh
cd surface
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run test
```

```ts
import { flow } from "@relayflows/surface";

export default flow<{ base: string }>("release-note", {}, async (f, input) => {
  await f.run(`git diff ${input.base}`);
  f.done("success");
});
```

Run it with inline JSON or the path to a JSON file:

```sh
flows run release-note.flow.ts --input '{"base":"main"}'
flows run release-note.flow.ts --input ./release-note.input.json
```

Direct runs use the same journal-backed executor as other authored flows, so
branches over step output observe the value recorded by `step.completed`.
Unsupported headers, verbs, and code predicate gates fail closed.
