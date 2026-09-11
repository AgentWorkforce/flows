# L1 schema acceptance evidence — 2026-09-11

Suggested PR title: `feat(schema): publish @relayflows/schema for YAML editor validation`
The lead supplies the tracking issue number when opening the push-only PR.

JSON Schema gives existing YAML/JSON editors completion, hover documentation,
and structural validation with no Relayflows-specific extension or process.
The package is data-only. A small TypeScript AST walker reads all exported
interfaces and aliases in SDK spec.ts; runtime value refinements are isolated
from generated field shapes. The SDK's existing TypeScript/Ajv dependencies are
build/test tooling only. Output meta-schemas are bundled locally and attributed.

The editor entry point is FlowSpec. Kernel definitions are included for type
coverage but do not broaden the entry point. No spec.ts or kernel schema-bound
changes were needed. The existing SDK bounded-reference checker accepts the
emitted schema. Runtime graph/reference/environment checks remain explicitly
outside JSON Schema's structural scope.

The check hint is warning-only and preserves file bytes and refusal behavior.
The RunReport diagnostic type follows CheckReport so check warnings survive
flows run. The existing exact CLI report expectation now pins the added warning.

Release CI regenerates and checks drift before publication, packs only data and
documentation, then publishes npm and deploys retained versioned Pages files.
No publication was run. NPM_TOKEN, GitHub Actions Pages, custom domain and DNS
must be configured by repository maintainers. GITHUB_TOKEN-created release tags
need the documented explicit schema workflow dispatch. npm package versions
follow stable release tags; the schema URL tracks the authoring dialect v0.1.

## Dependency setup

All commands run from this worktree unless a cwd is shown. Node 25.8.1, Bun
1.4.2, VS Code's installed app, Red Hat YAML 1.24.0. The SDK's registry surface
2.0.8 lacks current source exports, so use the locally built surface, as the
repository release workflow does:

```sh
npm ci --prefix packages/sdk --ignore-scripts --no-audit --no-fund
npm ci --prefix packages/surface --ignore-scripts --no-audit --no-fund
npm run --prefix packages/surface build
# cwd packages/surface
npm pack --pack-destination /tmp --ignore-scripts
# cwd packages/sdk
npm install --no-save --package-lock=false --ignore-scripts /tmp/relayflows-surface-2.0.8.tgz
```

## Schema parity and packaging smoke

Command: `PATH="/Users/khaliqgant/.bun/bin:$PATH" bun run --cwd packages/schema test`

Literal output:

```text
$ bun test tests
bun test v1.4.2 (744846f84)

tests/smoke.test.ts:
(pass) all exported spec type nodes have documented definitions [20.21ms]
(pass) regeneration is byte-stable and committed schema has not drifted [309.45ms]
(pass) npm tarball contains only data and documentation with no runtime dependencies [366.96ms]

tests/parity.test.ts:
(pass) flows check fixture parity: backlog-picker.flow.yaml [15.60ms]
(pass) flows check fixture parity: dir-watcher.flow.yaml [213.32ms]
(pass) flows check fixture parity: hello-agent.flow.yaml [11.60ms]
(pass) flows check fixture parity: hello-deterministic.flow.yaml [4.01ms]
(pass) flows check fixture parity: hello-ladder.flow.yaml [23.62ms]
(pass) flows check fixture parity: hello-llm.flow.yaml [21.34ms]
(pass) flows check fixture parity: hn-monitor.flow.yaml [131.31ms]
(pass) flows check fixture parity: json-schema-invalid.flow.yaml [6.38ms]
(pass) flows check fixture parity: step-memory.flow.yaml [130.77ms]
(pass) flows check fixture parity: step-placement.flow.yaml [2.65ms]
(pass) flows check fixture parity: tick-heartbeat.flow.yaml [36.51ms]
(pass) structural parity: unknown root key [0.52ms]
(pass) structural parity: unsupported version [0.06ms]
(pass) structural parity: no steps [0.26ms]
(pass) structural parity: step typo [0.10ms]
(pass) structural parity: empty command [0.02ms]
(pass) structural parity: positive timeout [0.04ms]
(pass) structural parity: fractional retry [0.04ms]
(pass) structural parity: wrong step field [0.06ms]
(pass) structural parity: nonzero exit gate [0.06ms]
(pass) structural parity: legacy zero exit gate [0.04ms]
(pass) structural parity: boolean schema [0.47ms]
(pass) structural parity: nested invalid schema [4.12ms]
(pass) structural parity: bad memory budget [0.12ms]
(pass) structural parity: unsafe memory budget [0.05ms]
(pass) structural parity: empty memory query [0.03ms]
(pass) structural parity: unsafe duration [0.13ms]
(pass) structural parity: bad money [0.04ms]
(pass) structural parity: bad input index [0.13ms]
(pass) structural parity: blank input name [0.09ms]
(pass) structural parity: trigger silence budget [0.04ms]
(pass) structural parity: llm: output object [7.19ms]
(pass) structural parity: llm: boolean output [0.12ms]
(pass) structural parity: llm: output and verification [5.83ms]
(pass) structural parity: llm: exit gate [0.14ms]
(pass) structural parity: llm: trimmed model [0.07ms]
(pass) structural parity: llm: control in model [0.03ms]
(pass) structural parity: agent: output object [7.51ms]
(pass) structural parity: agent: boolean output [0.11ms]
(pass) structural parity: agent: output and verification [3.65ms]
(pass) structural parity: agent: exit gate [0.10ms]
(pass) structural parity: agent: trimmed model [0.04ms]
(pass) structural parity: agent: control in model [0.03ms]
(pass) step examples compile and validate [0.68ms]
(pass) generated schema satisfies the existing bounded-reference rule [2.65ms]
(pass) semantic checks remain explicit runtime responsibilities [0.81ms]
(pass) embedded dialect http://json-schema.org/draft-04/schema# [6.26ms]
(pass) embedded dialect http://json-schema.org/draft-06/schema# [5.35ms]
(pass) embedded dialect http://json-schema.org/draft-07/schema# [7.79ms]
(pass) embedded dialect https://json-schema.org/draft/2019-09/schema [10.29ms]
(pass) embedded dialect https://json-schema.org/draft/2020-12/schema [8.63ms]
(pass) header hint is warning-only, first-line aware, and never edits input [15.67ms]
(pass) canonical surface parity: "repo" [0.13ms]
(pass) canonical surface parity: "/repo/src" [0.04ms]
(pass) canonical surface parity: "pr://github/example" [0.02ms]
(pass) canonical surface parity: "/" [0.02ms]
(pass) canonical surface parity: "pr://" [0.02ms]
(pass) canonical surface parity: "" [0.04ms]
(pass) canonical surface parity: " repo" [0.03ms]
(pass) canonical surface parity: "repo " [0.02ms]
(pass) canonical surface parity: "repo//src" [0.02ms]
(pass) canonical surface parity: "repo/../src" [0.02ms]
(pass) canonical surface parity: "repo/." [0.01ms]
(pass) canonical surface parity: ":/bad//path" [0.02ms]
(pass) named declarations and selected input paths use authoring shapes [25.84ms]

 68 pass
 0 fail
 3408 expect() calls
Ran 68 tests across 2 files. [1.70s]
```

The 11 top-level fixture files are copied byte-for-byte into a temporary project
with local executable CLI probes and the fixture model registry. This runs the
real checkFlow implementation with no ignored environment refusals and no live
provider calls. The negative anchor asserts the actual embedded `/type` node.
Additional cases compare structural accept/refuse decisions against compileSpec;
explicit scope tests show the DAG and embedded ref-cycle checks still require
runtime validation.

## SDK regression

Command: `npm run --prefix packages/sdk typecheck`

Literal output:

```text

> @relayflows/sdk@2.0.8 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json

```

Command: `npm run --prefix packages/sdk typecheck:tests`

Literal output:

```text
> @relayflows/sdk@2.0.8 typecheck:tests
> tsc -p tsconfig.tests.json
```

Command (cwd `packages/sdk`):
`./node_modules/.bin/vitest run tests/preflight.test.ts tests/cli.test.ts`

Literal output:

```text

 RUN  v2.1.9 /Users/khaliqgant/flows-spec-L1-schema/packages/sdk

 ✓ tests/preflight.test.ts (27 tests) 23ms
 ✓ tests/cli.test.ts (63 tests) 11015ms
   ✓ flows check CLI > refuses a typo model before probing or contacting relayflowd 671ms
   ✓ flows check CLI > maps every input refusal path to its declared kind without raw exceptions 1849ms
   ✓ flows run/resume CLI over the journal protocol > parses run options, submits the kernel dialect, and exits 0 on success 644ms
   ✓ flows run/resume CLI over the journal protocol > exits 1 and emits the declared completionReason for a failed run 576ms
   ✓ flows run/resume CLI over the journal protocol > exits 3 and names the parked llm step 623ms
   ✓ flows run/resume CLI over the journal protocol > reports a needs_human agent step as parked for human recovery 610ms
   ✓ flows run/resume CLI over the journal protocol > classifies a typed hello refusal as a protocol error, not an unreachable daemon 563ms
   ✓ flows run/resume CLI over the journal protocol > follows a dispatched worker step instead of reporting a protocol error 659ms
   ✓ flows run/resume CLI over the journal protocol > bounds a worker wait by its lease and reports what it is waiting for 640ms
   ✓ flows run/resume CLI over the journal protocol > resumes a parked run from snapshot step types without reading journal sequence one 569ms
   ✓ flows run/resume CLI over the journal protocol > maps only run_not_found resumes to exit 2 1724ms

 Test Files  2 passed (2)
      Tests  90 passed (90)
   Start at  11:30:15
   Duration  11.48s (transform 213ms, setup 0ms, collect 498ms, tests 11.04s, environment 0ms, prepare 62ms)

```

## Repeatability and workflow syntax

Commands:

```sh
node scripts/generate-json-schema.mjs /tmp/relayflows-schema-evidence/first.json
node scripts/generate-json-schema.mjs /tmp/relayflows-schema-evidence/second.json
diff -q /tmp/relayflows-schema-evidence/first.json /tmp/relayflows-schema-evidence/second.json
diff -q /tmp/relayflows-schema-evidence/first.json packages/schema/flows.schema.json
actionlint .github/workflows/schema-publish.yml
git diff --check
```

Literal output (exit 0; diff/actionlint/git diff produced no output):

```text
Generated packages/schema/flows.schema.json (58 definitions)
Generated packages/schema/flows.schema.json (58 definitions)
```

## Actual VS Code smoke

Executed through VS Code's extension-test host (automated edits in the real
editor, not a mock validator). A disposable user profile and workspace mapped
the local schema; the fixture was restored byte-for-byte after saving each edit.
No human manual inspection is claimed.

1. Open `testdata/hello-deterministic.flow.yaml` with the local schema registered.
2. Insert `identitty: chief` on line one and save. Wait for a diagnostic naming it.
3. Restore the original content and save. Wait for zero error diagnostics.

The brief suggests correcting `identitty` to `identity`; neither is accepted by
canonical FlowSpec today, so the correct repair is to remove the added line.

Commands:

```sh
'/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' --extensions-dir /tmp/relayflows-schema-editor-extensions --install-extension redhat.vscode-yaml
'/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' /tmp/relayflows-schema-vscode-harness/smoke.code-workspace --user-data-dir /tmp/relayflows-schema-editor-profile --extensions-dir /tmp/relayflows-schema-editor-extensions --extensionDevelopmentPath=/tmp/relayflows-schema-vscode-harness --extensionTestsPath=/tmp/relayflows-schema-vscode-harness/test.cjs --disable-workspace-trust --skip-welcome --skip-release-notes --wait
cat /tmp/relayflows-schema-editor-result.json
```

Literal install output:

```text
Installing extensions...
Installing extension 'redhat.vscode-yaml'...
Extension 'redhat.vscode-yaml' v1.24.0 was successfully installed.
```

The editor command exited 0 with no stdout. Literal result:

```json
{
  "ok": true,
  "events": [
    {
      "phase": "baseline",
      "errors": []
    },
    {
      "phase": "typo-saved",
      "errors": [
        "Property identitty is not allowed."
      ]
    },
    {
      "phase": "restored-saved",
      "errors": []
    }
  ]
}
```

The test host source used for that command is captured below. Its temporary
package.json names it as an extension with `main: ./extension.cjs`; that module
exports `activate = () => {}`. The temporary code-workspace points at this
checkout and sets `security.workspace.trust.enabled: false`.

```js
const vscode = require('vscode');
const fs = require('node:fs');
exports.run = async () => {
  const events = [];
  const output = '/tmp/relayflows-schema-editor-result.json';
  try {
    const extension = vscode.extensions.getExtension('redhat.vscode-yaml');
    if (!extension) throw new Error('YAML extension unavailable');
    await extension.activate();
    const uri = vscode.Uri.file('/Users/khaliqgant/flows-spec-L1-schema/testdata/hello-deterministic.flow.yaml');
    const config = vscode.workspace.getConfiguration('yaml');
    const previousSchemas = config.inspect('schemas').workspaceValue;
    // Test host uses a disposable workspace file, not the checkout's settings.
    await config.update('schemas', { '/Users/khaliqgant/flows-spec-L1-schema/packages/schema/flows.schema.json': ['**/*.flow.yaml'] }, vscode.ConfigurationTarget.Workspace);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    const original = document.getText();
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const diagnostics = () => vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    const wait = async predicate => { for (let i=0;i<100;i++) { await delay(100); if(predicate()) return; } throw new Error('Timed out waiting for editor diagnostics: '+JSON.stringify(diagnostics())); };
    try {
      // Give language server activation/configuration time to settle.
      await delay(2000);
      events.push({phase:'baseline',errors:diagnostics().map(d=>d.message)});
      const edit = new vscode.WorkspaceEdit(); edit.insert(uri,new vscode.Position(0,0),'identitty: chief\n');
      await vscode.workspace.applyEdit(edit); await document.save();
      await wait(()=>diagnostics().some(d=>d.message.includes('identitty')));
      events.push({phase:'typo-saved',errors:diagnostics().map(d=>d.message)});
      const undo = new vscode.WorkspaceEdit(); undo.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),original);
      await vscode.workspace.applyEdit(undo); await document.save();
      await wait(()=>diagnostics().length===0);
      events.push({phase:'restored-saved',errors:diagnostics().map(d=>d.message)});
    } finally {
      fs.writeFileSync(uri.fsPath, original);
      await config.update('schemas', previousSchemas, vscode.ConfigurationTarget.Workspace);
    }
    fs.writeFileSync(output,JSON.stringify({ok:true,events},null,2)+'\n');
  } catch(error) { fs.writeFileSync(output,JSON.stringify({ok:false,error:String(error),events},null,2)+'\n'); throw error; }
};
```
