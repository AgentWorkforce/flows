# @relayflows/ts-plugin

TypeScript language service plugin for Relayflows authoring. This first slice
reports unknown literal header keys (code `98001`) in `flow(name, header, body)`
calls imported from `@relayflows/surface`, with suggestions within Levenshtein
distance two. It also checks literal `memory` and `tools` objects.

After installing the package as a development dependency, enable it with:

```json
{ "compilerOptions": { "plugins": [{ "name": "@relayflows/ts-plugin" }] } }
```

Use the project's TypeScript version in your editor and restart its TypeScript
server. Language service plugins run in compatible editors; `tsc` does not
load them. Keep `flows check` as the validation boundary.

Direct named imports, aliased named imports, and namespace imports are supported.
Analysis uses the editor's current source snapshot and never imports the flow,
executes its body, invokes preflight probes, or contacts a provider. Dynamic
headers, spreads, computed expressions, and re-exported factories are not
resolved. A statically named unknown key alongside a spread can still be
reported; nested objects that a later field or spread may replace are skipped.

See [the editor guide](../../docs/EDITOR.md) for development commands and the
remaining L2 rules. This is the minimal header-key slice, not full L2 coverage.
