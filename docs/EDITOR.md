# Relayflows editor diagnostics

`@relayflows/ts-plugin` adds authoring diagnostics to editors using TypeScript's
language service. The initial L2 slice checks the header-key allowlist, including
the literal `memory` and `tools` subobjects. It marks the offending key with
error code `98001` and suggests the closest allowed spelling when its
Levenshtein distance is at most two.

## Enable the plugin

After the package is published, install it alongside your project's TypeScript:

```sh
npm install --save-dev typescript @relayflows/ts-plugin
```

Add this entry to `tsconfig.json`:

```json
{ "compilerOptions": { "plugins": [{ "name": "@relayflows/ts-plugin" }] } }
```

Select the workspace TypeScript version in your editor, then restart its
TypeScript server. For example, VS Code provides **TypeScript: Select TypeScript
Version** and **TypeScript: Restart TS Server** commands. No per-editor
extension is required. The package targets TypeScript 5.6 and later 5.x releases;
the tests use 5.6.3.

Before publication, build the package using the development commands below,
then install it into a consumer with
`npm install --save-dev /absolute/path/to/flows/packages/ts-plugin`.

```ts
import { flow } from '@relayflows/surface';

export default flow('release', { identty: 'release' }, async (f) => {
  await f.run('git diff main');
});
//                             ^^^^^^^ unknown field; Did you mean "identity"?
```

The plugin uses TypeScript's import symbols so unrelated or shadowed functions
named `flow` do not receive Relayflows diagnostics. Direct named imports,
renamed imports, and namespace imports from `@relayflows/surface` are supported.
Literal headers wrapped in parentheses, `as`, or `satisfies` are inspected.
Headers held in variables, re-exported factories, dynamic computed keys, and
spread contents remain unchecked. A nested object that a later property or
spread might replace is also left unchecked. The absence of editor diagnostics
does not prove that a dynamic header is valid.

The plugin never executes author code or SDK preflight. Its allowlists mirror
`assertFlowHeader` in `packages/surface/src/flow.ts`; parity fixtures exercise
the actual SDK `checkHelperBody` entry point used by `flows check <flow.ts>`.
Each intentionally bad fixture has one header refusal, and the comparison
requires the same number and kind of diagnostic on both sides. The baseline
fixtures require both sides to return zero diagnostics. These tests pin the
implemented static subset; they do not claim equivalence for arbitrary code.

Language service plugins affect editor diagnostics, not `tsc`. Continue using
`flows check` before a run. See TypeScript's official
[plugin guide](https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin)
for how editors load and configure plugins.

## Development and verification

From the repository root, install the existing SDK and surface dependencies
needed by the parity test, then build the surface and plugin:

```sh
npm --prefix packages/sdk ci --ignore-scripts
npm --prefix packages/surface ci --ignore-scripts
npm --prefix packages/surface run build
npm --prefix packages/ts-plugin ci --ignore-scripts
npm --prefix packages/ts-plugin run build
npm --prefix packages/ts-plugin test
npm --prefix packages/ts-plugin run typecheck
```

The test harness creates a real `ts.LanguageService`, wraps it with the built
CommonJS plugin, and asserts diagnostic codes, categories, and source spans.
It also verifies native diagnostics remain present and unsaved edits update
the plugin diagnostics. Parity loads only trusted test fixtures through the
SDK; fixture bodies throw if executed. No daemon, CLI authentication, or model
call is needed for this suite.

## Remaining L2 work

The minimal-slice mandate delivers one diagnostic kind. The following rule
families remain follow-up work and are not advertised as shipped:

- `use:` path resolution.
- Named-agent references.
- `f.mcp.<server>` against declared `tools.mcp`.
- JSON Schema unbounded cycles, vacuous gates, and unknown keywords.
- `model:` against the nearest `flows.json` allowlist.
- Duplicate step IDs within a flow.

Those rules need their own SDK parity fixtures and source spans. YAML, runtime
probes, quick fixes, and a full language server remain outside this package's
scope. This slice changes no SDK, surface, or kernel semantics.
