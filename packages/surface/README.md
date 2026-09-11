# `@relayflows/surface`

The TypeScript authoring contract described by `docs/SURFACE.md`.

The package defines flows and the context that a future journal-backed runtime
will inject. A flow handle retains an immutable header and body behind the
`@relayflows/surface/runtime` bridge used by in-repository SDK inspection; the
public handle remains the frozen `{ name }` authoring value. This package never
constructs a context, executes a body, or contacts the kernel. The SDK has an
internal test seam proving an awaited plain `f.run(...)` can cross the existing
journal protocol, but it is intentionally not exported as a runner: authored
body progress does not yet have a durable root journal or crash-safe resume.
Within that seam, a root operation must participate in the asynchronous
continuation that reaches `done()`. Direct `await` is supported, including steps
constructed before they are awaited, and so are awaited `Promise.resolve`,
`Promise.all`, `Promise.allSettled`, `Promise.any` and `Promise.race`. Ignored
operations, manual `.then` callbacks, ignored combinators, callback failures that
are caught away, and derived work still in flight when the body returns are all
refused before the terminal journal step; callback source text is never treated
as lifecycle proof.

Note that executing an authored body replaces the global `Promise.all` for the
duration of the run. The reason, the scope, and the one documented limit of the
lifecycle contract are in `docs/SURFACE.md`, "The authored operation lifecycle".

This is an in-repository foundation, not a registry-published package. The
repository's `flows run` command can execute a directly authored `.flow.ts`
with required JSON input. Durable authored-root resume remains tracked in issue
#132. `flow.on(...)` records webhook and generated provider subscriptions.
See [provider event triggers](src/triggers/README.md) for declarations, inbox
envelopes, and executor bindings; deploying handler bodies is tracked in #301.

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

Direct input is limited to 1,048,576 UTF-8 bytes. Missing, invalid, or
oversized input is refused before the daemon is contacted.

Direct runs use the same journal-backed executor as other authored flows, so
branches over step output observe the value recorded by `step.completed`.
Unsupported headers, verbs, and code predicate gates fail closed.
