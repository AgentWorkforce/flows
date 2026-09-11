# @relayflows/schema

JSON Schema (draft 2020-12) for Relayflows YAML/JSON authoring. The committed JSON
file is the complete package: no runtime dependencies and no consumer build.

Use your editor's existing YAML support and register
`https://schema.relayflows.dev/v0.1/flows.schema.json`, or add this first line:

```yaml
# yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
```

The URL is reserved until the repository's Pages/custom-domain setup is complete.
For immediate offline use, download `flows.schema.json` or install
`npm install --save-dev @relayflows/schema` and map
`node_modules/@relayflows/schema/flows.schema.json` to `**/*.flow.yaml`.
Both the package root and `@relayflows/schema/flows.schema.json` export the JSON.
See [editor setup](https://github.com/AgentWorkforce/flows/blob/main/docs/EDITOR.md)
for VS Code, Cursor, JetBrains, Neovim, and local-file mappings.

The root describes the canonical SDK `FlowSpec`; the definitions include every
exported interface/type in `spec.ts`, including kernel types for reference.
Generated documentation comes from TypeScript JSDoc, with labels for undocumented
nodes. Step examples adapt SURFACE.md's examples to the current canonical dialect.

Maintain in the repository:

```sh
npm ci --prefix packages/sdk --ignore-scripts
node scripts/generate-json-schema.mjs
cd packages/schema
bun run test
```

The AST walker uses the SDK's existing development TypeScript compiler and fails
on unsupported syntax. It never executes SDK code. Value constraints supplement
types in `scripts/schema-constraints.mjs`; bundled official Ajv meta-schemas
validate output declarations offline. Standard JSON Schema does not replace
`flows check` for cross-step references, dependency cycles, schema-reference
termination, model registries, or environment readiness.

Release maintainers: `schema-publish.yml` runs on stable `vX.Y.Z` release tags.
It regenerates and checks the committed artifact, runs parity, publishes the npm
package at the release version, and preserves previous Pages files while adding
`vX.Y.Z/flows.schema.json` and the authoring-version alias `v0.1/flows.schema.json`.
Configure the repository's Pages source as **GitHub Actions**, the custom domain
`schema.relayflows.dev` and its DNS, and the `NPM_TOKEN` secret for publishing.
The schema `$id` tracks the authoring dialect, independent of the npm release.

Tags made by another workflow using `GITHUB_TOKEN` do not trigger push workflows
([GitHub's rule](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).
For the existing Publish Package workflow, dispatch **Publish schema** afterward
with its exact release tag, or have release automation dispatch it explicitly.
Publication is never performed by generation, testing, packing, or this PR.
