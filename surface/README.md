# `@relayflows/surface`

The TypeScript authoring contract described by `docs/SURFACE.md`.

The package defines flows and the context that a journal-backed runtime
injects. A flow handle retains an immutable header and body behind the
`@relayflows/surface/runtime` bridge used by `@relayflows/sdk`; the public
handle remains the frozen `{ name }` authoring value. This package never
constructs a context, executes a body on its own, or contacts the kernel.
Those responsibilities stay behind `@relayflows/sdk` and the journal protocol.

This is currently an in-repository foundation, not a registry-published or
direct-run surface. Direct `.flow.ts` execution and input remain tracked in
issue #132. Resident trigger handlers (`flow.on(...)`) are gate-2 work and are
not yet part of this package.

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
  const diff = await f.run("git diff main");
  await f.llm`Write a one-line release note for ${diff}`;
  f.done("success");
});
```
