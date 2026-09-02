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
