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
# YAML and JSON editor validation

Register the published draft 2020-12 schema for the canonical declarative
`FlowSpec` dialect (`version`, `steps`, and explicit `type` fields). The schema
provides completion, hover documentation, and structural diagnostics using your
editor's YAML/JSON support; no Relayflows extension, server, or npm install is
needed. VS Code and Cursor need their usual YAML language support (Red Hat YAML
if it is not already installed). JetBrains includes schema-backed YAML support.

The versioned schema URL is reserved for publication:
`https://schema.relayflows.dev/v0.1/flows.schema.json`. Until that hosting is
configured, use the committed `packages/schema/flows.schema.json` locally.
The npm package also ships this exact file, with zero runtime dependencies.

## VS Code / Cursor

Add to `.vscode/settings.json` (or user settings):

```json
{
  "yaml.validate": true,
  "yaml.schemas": {
    "https://schema.relayflows.dev/v0.1/flows.schema.json": ["**/*.flow.yaml", "**/*.flow.yml"]
  },
  "json.schemas": [{
    "fileMatch": ["**/*.flow.json"],
    "url": "https://schema.relayflows.dev/v0.1/flows.schema.json"
  }]
}
```

For offline use, replace the URL with `./packages/schema/flows.schema.json`
(relative to the workspace) or `./node_modules/@relayflows/schema/flows.schema.json`
if installed with `npm install --save-dev @relayflows/schema`.
The modeline and mapping behavior is documented by
[yaml-language-server](https://github.com/redhat-developer/yaml-language-server#language-server-settings).

## JetBrains

1. Open Settings / Preferences → Languages & Frameworks → Schemas and DTDs →
   JSON Schema Mappings.
2. Add a mapping named **Relayflows**, select JSON Schema version **2020-12**,
   and choose the URL above or the local `flows.schema.json` file.
3. Add file path patterns `*.flow.yaml`, `*.flow.yml`, and `*.flow.json`.
4. Open a flow and verify that the status-bar schema selector says **Relayflows**.

See JetBrains' [YAML schema support](https://www.jetbrains.com/help/idea/yaml.html)
and [JSON schema mappings](https://www.jetbrains.com/help/idea/json.html).

## Neovim

With `yaml-language-server` on PATH, Neovim 0.11+ can start it directly:

```lua
vim.lsp.config('relayflows_yaml', {
  cmd = { 'yaml-language-server', '--stdio' },
  filetypes = { 'yaml' },
  root_markers = { '.git', 'flows.json' },
  settings = {
    yaml = {
      validate = true,
      schemas = {
        ['https://schema.relayflows.dev/v0.1/flows.schema.json'] = {
          '**/*.flow.yaml', '**/*.flow.yml',
        },
      },
    },
  },
})
vim.lsp.enable('relayflows_yaml')
```

If you already use `nvim-lspconfig`'s `yamlls`, merge the `settings.yaml` block
into that configuration instead of starting a second server. Local absolute
schema paths also work.

## Per-file fallback

Put this on the first line of a YAML flow:

```yaml
# yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
version: '0.1.0'
steps:
  - id: greet
    type: deterministic
    command: echo hello
```

A relative local URL is resolved from the YAML file: for the repository's
`testdata/hello-deterministic.flow.yaml`, use
`# yaml-language-server: $schema=../packages/schema/flows.schema.json`.
The language server modeline takes precedence over settings. `flows check`
emits `editor_schema_missing` as a warning when a `.flow.yaml` file lacks this
first-line comment, including when a settings mapping is already configured.
It never changes the file or refuses a valid flow because of that warning.

## Validation scope

The schema follows `packages/sdk/src/spec.ts`, with structural constraints from
runtime validation: closed objects, discriminated step types, required fields,
value bounds, named-agent declaration shapes, input selectors, and output
schema keyword shapes for SDK-supported drafts. The generated file bundles its
meta-schemas and needs no network after the file itself has loaded.

`flows check` remains necessary for unique step/trigger IDs, dependency cycles,
named-agent and input-source lookup, declared output-path lookup, JSON Schema
reference resolution/termination and regex compilation, model allowlists, CLI
authentication, and executor readiness. JSON Schema cannot express comparisons
against arbitrary values elsewhere in the flow. Embedded schemas may use
unknown annotation keywords, just as the SDK permits. Future surface shorthand
such as `run:` and headers such as `identity:` are not canonical `FlowSpec`
fields today; both `identity:` and its typo `identitty:` are rejected here.
Compiled snake_case kernel JSON is a separate dialect and is not the editor
schema's entry point, even though `flows check` can also ingest it.

## Editor smoke procedure

1. Register the local schema and open `testdata/hello-deterministic.flow.yaml`.
2. Add `identitty: chief` at the root, save, and observe an unknown-property
   squiggle. Remove the whole added line, save, and confirm it clears.
3. Change a deterministic step's `command` to `commmand`; confirm the unknown
   field and missing required `command` diagnostics. Undo and save.
4. Hover `timeoutMs` and inspect completion after `type: agent`.

Do not correct `identitty` to `identity` in this dialect: neither is supported.
