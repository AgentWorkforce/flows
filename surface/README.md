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

This is an unpublished contract foundation, not a shipped executable surface.
Direct `.flow.ts` execution, durable authored-root resume, and input remain
tracked in issue #132. Resident trigger handlers (`flow.on(...)`) are gate-2
work and are not yet part of this package.

The repository pins Bun through `surface/bun.lock`. From a fresh checkout:

```sh
cd surface
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run test
```

```ts
import { flow } from "@relayflows/surface";

export default flow("release-note", async (f) => {
  await f.run("git diff main");
  f.done("success");
});
```
