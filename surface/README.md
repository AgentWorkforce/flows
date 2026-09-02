# `@relayflows/surface`

The TypeScript authoring contract described by `docs/SURFACE.md`.

The package defines flows and the context that a journal-backed runtime
injects. It does not construct a context, retain or execute flow bodies, or contact the kernel;
those responsibilities stay behind `@relayflows/sdk` and the journal protocol.

```ts
import { flow } from "@relayflows/surface";

export default flow("release-note", async (f) => {
  const diff = await f.run("git diff main");
  await f.llm`Write a one-line release note for ${diff}`;
  f.done("success");
});
```
