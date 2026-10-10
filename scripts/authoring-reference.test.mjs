import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, source, declarationText, unionDeclarations, literal, exportedNames, typeExports, typeReferences, ts } from './authoring-source.mjs';

const read = path => readFileSync(join(root, path), 'utf8');
const authoring = read('packages/surface/AUTHORING.md');
const cli = read('docs/CLI.md');
const context = read('packages/surface/src/context.ts');
const interfaceText = (text, name) => {
  const match = text.match(new RegExp(`export interface ${name}[^\\n]*\\{([\\s\\S]*?)^}`, 'm'));
  assert.ok(match, name);
  return match[1];
};
const members = text => [...text.matchAll(/^  (?:readonly )?(\w+)\??[:(]/gm)].map(match => match[1]);
const fixture = text => source('fixture.ts', text);

test('extracts overloads in order and preserves lease JSDoc byte-for-byte', () => {
  const text = '/** default 30s, maximum 15m. */\nexport interface Ctx {\n  run(a: string): string;\n  run(a: number): number;\n  run(a: boolean): boolean;\n}';
  assert.equal(declarationText(fixture(text), 'Ctx'), text);
});
test('walks union members even when not re-exported, including nested unions', () => {
  const file = fixture("export type Named = Hidden | Nested;\ninterface Hidden { type: 'hidden' }\ntype Nested = Last;\ninterface Last { type: 'last' }");
  assert.match(unionDeclarations(file, 'Named').join('\n'), /interface Hidden/);
  assert.match(unionDeclarations(file, 'Named').join('\n'), /interface Last/);
});
test('CLI literals refuse unresolved options with command and identifier', () => {
  assert.throws(() => literal(fixture("const CLI_VERBS = [{name: 'run', options: [MISSING]}];"), 'CLI_VERBS'), /run.options:.*MISSING/);
});
test('CLI literals resolve imports, spreads, String and templates but refuse dynamic defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'authoring-literals-'));
  try {
    writeFileSync(join(dir, 'constants.ts'), 'export const CAPACITY = 4;');
    const file = source(join(dir, 'cli.ts'), "import { CAPACITY } from './constants.js'; const SHARED = [{flags: '--n', defaultValue: String(CAPACITY), description: `up to ${CAPACITY}`}]; const CLI_VERBS = [{name: 'run', options: [...SHARED]}] as const satisfies unknown;");
    assert.deepEqual(literal(file, 'CLI_VERBS'), [{ name: 'run', options: [{ flags: '--n', defaultValue: '4', description: 'up to 4' }] }]);
    for (const expression of ['homedir()', 'process.env.HOME', 'getDefault()']) {
      writeFileSync(join(dir, 'constants.ts'), `export const CAPACITY = ${expression};`);
      assert.throws(() => literal(file, 'CLI_VERBS'), /unresolved literal/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('run documents every exported overload and the lease comment', () => {
  const overloads = context.match(/^  run\(.+;$/gm);
  assert.equal(overloads.length, 3);
  for (const signature of overloads) assert.ok(authoring.includes(signature));
  const comment = context.match(/Command lease:[^\n]+/)[0];
  assert.ok(authoring.includes(comment));
  assert.match(authoring, /default 10m, maximum 15m/);
});
test('done documents all three distinct completion vocabularies', () => {
  const text = read('packages/surface/src/completion.ts');
  // Independent source reader: expand array spreads using raw text, not the AST evaluator.
  const reasons = name => [...text.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))[1]
    .matchAll(/\.\.\.(\w+)|["'](\w+)["']/g)].flatMap(match => match[1] ? reasons(match[1]) : [match[2]]);
  for (const name of ['FLOW_COMPLETION_REASONS', 'RUN_COMPLETION_REASONS', 'COMPLETION_REASONS']) {
    const row = authoring.split('\n').find(line => line.startsWith(`| \`${name}\``));
    assert.ok(row);
    const [, type, , values] = row.split('|').slice(1, -1).map(cell => cell.trim());
    assert.equal(type, `\`${text.match(new RegExp(`export type (\\w+) = \\(typeof ${name}\\)\\[number\\]`))[1]}\``);
    assert.deepEqual([...values.matchAll(/`(\w+)`/g)].map(match => match[1]), reasons(name));
  }
  assert.equal(reasons('FLOW_COMPLETION_REASONS').length, 6);
  assert.ok(authoring.includes(context.match(/^  done\(.+;$/m)[0]));
});
test('human returns Step<boolean>', () => {
  assert.ok(authoring.includes('human(question: string, options: { to: string }): Step<boolean>'));
});
test('all helper namespaces and mcp are discoverable', () => {
  const names = members(interfaceText(read('packages/surface/src/helpers/index.ts'), 'Helpers'));
  assert.equal(names.length, 50);
  for (const name of names) assert.ok(authoring.includes(`| \`f.${name}\` |`), name);
  assert.match(authoring, /Ctx extends Helpers/);
  assert.match(authoring, /readonly mcp:/);
  assert.match(authoring, /f\.slack/);
});
for (const [name, path] of [['FlowHeader', 'flow'], ['AgentOptions', 'context']]) {
  test(`${name} includes every field and its declaration`, () => {
    const fields = interfaceText(read(`packages/surface/src/${path}.ts`), name);
    assert.equal(interfaceText(authoring, name), fields);
    assert.ok(members(fields).includes(name === 'FlowHeader' ? 'use' : 'permissions'));
  });
}
test('all named gate variants and both gate overloads are documented', () => {
  const step = read('packages/surface/src/step.ts');
  const variants = [...step.matchAll(/type: '([^']+)'/g)].map(match => match[0]);
  assert.equal(variants.length, 5);
  for (const variant of variants) assert.ok(authoring.includes(variant));
  for (const signature of step.match(/^  gate\(.+;$/gm)) assert.ok(authoring.includes(signature));
});
test('CLI includes every declared verb, subcommand and literal flag', () => {
  const text = read('packages/sdk/src/cli-commands.ts');
  const names = [...text.matchAll(/^    name: '([^']+)'/gm)].map(match => match[1]);
  assert.equal(names.length, 25);
  for (const name of names) assert.ok(cli.includes(`## flows ${name}\n`), name);
  for (const [, flag] of text.matchAll(/flags: '([^']+)'/g)) assert.ok(cli.includes(flag.replaceAll('|', '\\|')), flag);
  for (const name of ['hn-monitor start', 'tick start', 'plugin list', 'plugin verify', 'plugin remove', 'plugin update']) assert.ok(cli.includes(`## flows ${name}\n`));
  assert.match(cli, /up to|1-32/);
  assert.match(cli, /`\.relayflowd`/);
});
test('lease prose agrees with type, kernel default and compiler ceiling', () => {
  const [, defaultMinutes, maximumMinutes] = context.match(/default (\d+)m, maximum (\d+)m/);
  const kernelSource = read('kernel/relayflowd-core/src/lib.rs');
  const kernel = kernelSource
    .match(/DEFAULT_DETERMINISTIC_TIMEOUT_MS: u64 = (\d+) \* 60_000;/)[1];
  assert.equal(kernel, defaultMinutes);
  const compiler = read('packages/sdk/src/compile.ts');
  assert.ok(compiler.includes(`RUN_STEP_TIMEOUT_MAX_MS = ${maximumMinutes} * 60_000`));
  assert.ok(compiler.includes('agent ? AGENT_STEP_TIMEOUT_MAX_MS : RUN_STEP_TIMEOUT_MAX_MS'));
  const surface = read('docs/SURFACE.md').split('### Command timeouts')[1].split('\n### ')[0];
  assert.ok(surface.includes(`default is **${defaultMinutes} minutes**`));
  assert.ok(surface.includes(`**${maximumMinutes} minutes**`));
  const readme = read('packages/surface/README.md');
  assert.ok(readme.includes(`**${defaultMinutes}m by default**`));
  assert.ok(readme.includes(`**${maximumMinutes}m maximum**`));
});
test('checker accepts exact docs, rejects drift or missing docs, and accepts restoration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'authoring-check-'));
  const docs = ['packages/surface/AUTHORING.md', 'docs/CLI.md'];
  const check = () => spawnSync(process.execPath, [join(root, 'scripts/check-authoring-reference.mjs'), '--docs-dir', dir], { encoding: 'utf8' });
  try {
    for (const file of docs) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), read(file)); }
    assert.equal(check().status, 0);
    for (const file of docs) {
      writeFileSync(join(dir, file), read(file) + '\n');
      const drift = check();
      assert.notEqual(drift.status, 0);
      assert.ok(drift.stderr.includes(file));
      assert.match(drift.stderr, /npm run gen:docs --prefix packages\/surface/);
      rmSync(join(dir, file));
      assert.notEqual(check().status, 0);
      writeFileSync(join(dir, file), read(file));
      assert.equal(check().status, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('every relative link in shipped surface markdown resolves inside the packed package', () => {
  // npm installs read these files from node_modules/@relayflows/surface, where
  // repository-relative links such as ../../docs/ resolve to nothing.
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: join(root, 'packages/surface'), encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = new Set(JSON.parse(packed.stdout)[0].files.map(file => file.path));
  const broken = [];
  for (const doc of [...files].filter(path => path.endsWith('.md'))) {
    const text = readFileSync(join(root, 'packages/surface', doc), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const path = posix.normalize(posix.join(posix.dirname(doc), target.split('#')[0]));
      if (!files.has(path)) broken.push(`${doc}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
test('every exported surface type the reference mentions is declared in it', () => {
  // A signature that names TriggerSource or CloudHelper without declaring it
  // sends the reader back to node_modules/*.d.ts, which this file replaces.
  const fences = [...authoring.matchAll(/```ts\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
  const exported = new Set(exportedNames(source(join(root, 'packages/surface/src/index.ts'))));
  // Rendered as tables rather than declarations.
  const tabulated = new Set(['Helpers', 'FlowCompletionReason', 'RunCompletionReason', 'CompletionReason']);
  const declared = name => new RegExp(`(?:(?:interface|type|function|const|class) ${name}\\b|export type \\{ ${name} \\} from)`).test(fences);
  const missing = typeReferences(fences).filter(name => exported.has(name) && !tabulated.has(name) && !declared(name));
  assert.deepEqual(missing, []);
});
test('trigger and helper entry points are documented', () => {
  for (const name of ['webhook', 'schedule', 'TriggerSource', 'ActivityOptions', 'Activity',
    'CloudHelper', 'MemoryHelper', 'SlackHelper']) {
    assert.match(authoring, new RegExp(`(?:interface|type|function|const) ${name}\\b`), name);
  }
  assert.match(authoring, /export function webhook\(name: string, filter\?: WebhookFilter\): WebhookTriggerSource;/);
  assert.match(authoring, /cron\(expression: string, options\?: ScheduleCronOptions\): ScheduleTriggerSource;/);
});
test('in-package re-exports are declared, never pointed at by a source path', () => {
  // A relative path written into the shipped AUTHORING.md resolves to nothing.
  assert.doesNotMatch(authoring, /export type \{ \w+ \} from ["']\./);
  assert.match(authoring, /export type SlackBlock = /);
  assert.match(authoring, /export type SlackAttachment = /);
});
test('every provider trigger reachable through star re-exports is documented', () => {
  const index = source(join(root, 'packages/surface/src/index.ts'));
  assert.ok(exportedNames(index).includes('github'), 'star re-exports are traversed');
  const triggers = join(root, 'packages/surface/src/triggers');
  let methods = 0;
  for (const name of readdirSync(triggers).filter(file => file.endsWith('.ts') && file !== 'index.ts')) {
    const text = readFileSync(join(triggers, name), 'utf8');
    const namespace = text.match(/export const (\w+) = Object\.freeze/)[1];
    for (const [, method, params] of text.matchAll(/^  (\w+)\(([^)]*)\) \{$/gm)) {
      methods += 1;
      assert.ok(authoring.includes(`| \`${namespace}.${method}(${params})\` |`), `${namespace}.${method}`);
    }
  }
  assert.ok(methods > 500, `found ${methods} provider trigger methods`);
  assert.match(authoring, /\| `github\.pull_request\(action\?: string\)` \| `github` \| `pull_request` \|/);
});
test('every function exported from the package root has its signature in the reference', () => {
  for (const name of ['flowRunWritebackIdempotency', 'scheduleIdFor', 'parseCron', 'cronGrid',
    'cronFixedIntervalMs', 'cronMaxGapMs', 'everyToMs', 'webhook', 'flow']) {
    assert.match(authoring, new RegExp(`export function ${name}[<(]`), name);
  }
});
test('every type a rendered declaration names is declared, imported or a TypeScript global', () => {
  const fences = [...authoring.matchAll(/```ts\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
  const file = source('fences.ts', fences);
  const generics = new Set();
  const collect = node => { if (ts.isTypeParameterDeclaration(node)) generics.add(node.name.text); ts.forEachChild(node, collect); };
  collect(file);
  const globals = new Set(['Array', 'ReadonlyArray', 'Promise', 'PromiseLike', 'Record', 'Partial', 'Required', 'Readonly',
    'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'Awaited', 'TemplateStringsArray',
    'Date', 'Error', 'Map', 'ReadonlyMap', 'Set', 'ReadonlySet', 'Uint8Array', 'Function', 'RegExp', 'ArrayBuffer', 'AbortSignal']);
  const tabulated = new Set(['Helpers', 'FlowCompletionReason', 'RunCompletionReason', 'CompletionReason']);
  const declared = name => new RegExp(`(?:(?:interface|type|function|const|class) ${name}\\b|(?:export|import)(?: type)? \\{ ${name} \\} from)`).test(fences);
  const helperTypes = [...authoring.matchAll(/^\| `f\.\w+` \| `(\w+)` \|/gm)].map(match => match[1]);
  assert.ok(helperTypes.includes('GithubHelper'));
  const missing = [...typeReferences(fences), ...helperTypes]
    .filter(name => !generics.has(name) && !globals.has(name) && !tabulated.has(name) && !declared(name));
  assert.deepEqual([...new Set(missing)], []);
});
test('declares every public type, including type-only exports no signature names', () => {
  const index = source(join(root, 'packages/surface/src/index.ts'));
  const names = typeExports(index).map(entry => entry.name);
  assert.ok(names.includes('PluginMethod') && names.includes('PluginPrimitive'));
  const missing = names.filter(name => !new RegExp(`(?:interface|type) ${name}\\b|### ${name}\\b|\\| \`${name}\` \\||\`Ctx extends ${name}\`|import(?: type)? \\{ ${name} \\}`).test(authoring));
  assert.deepEqual(missing, []);
});
test('claims only what it declares: dependency types are named, links name their version skew', () => {
  const external = [...authoring.matchAll(/^import(?: type)? \{ \w+ \} from "([^".][^"]*)";$/gm)].map(match => match[1]);
  assert.ok(external.length > 0);
  const header = authoring.slice(0, authoring.indexOf('\n## '));
  for (const module of new Set(external.filter(name => name.startsWith('@relayfile/')).map(name => name.split('/').slice(0, 2).join('/')))) assert.ok(header.includes(`\`${module}\``), module);
  assert.match(header, /named by its import line and not expanded/);
  assert.match(header, /links follow `main`; for an installed release, read the same files at this repository's `v<version>` tag/);
  assert.doesNotMatch(read('packages/surface/README.md'), /for all signatures/);
});
test('declares every package-root export, including declarations a star-exported barrel owns', () => {
  const index = source(join(root, 'packages/surface/src/index.ts'));
  const types = new Set(typeExports(index).map(entry => entry.name));
  const values = exportedNames(index).filter(name => !types.has(name));
  assert.ok(values.includes('providerEventTypes') && values.includes('COMPLETION_DETAIL_MAX_CODE_POINTS'));
  // A declaration or a table row, not an incidental mention in prose.
  const declared = name => new RegExp(`(?:const|function|class) ${name}\\b|^\\| \`${name}[.(\`]`, 'm').test(authoring);
  assert.deepEqual(values.filter(name => !declared(name)), []);
  assert.match(authoring, /export const COMPLETION_DETAIL_MAX_CODE_POINTS = 2000;/);
});
test('a copied implementation imports every free function it calls', () => {
  const blocks = authoring.split('// Return type inferred from this implementation.\n').slice(1).map(text => text.slice(0, text.indexOf('```')));
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    const file = fixture(block);
    const bound = new Set(), called = [];
    (function visit(node) {
      if ((ts.isImportSpecifier(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name && ts.isIdentifier(node.name)) bound.add(node.name.text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.push(node.expression.text);
      ts.forEachChild(node, visit);
    })(file);
    const globals = new Set(['Error', 'TypeError', 'Promise', 'String', 'Number', 'Boolean', 'Object', 'Array', 'JSON', 'encodeURIComponent']);
    assert.deepEqual(called.filter(name => !bound.has(name) && !globals.has(name)), [], block.match(/^export function \w+/m)[0]);
  }
});
test('CLI reference lists the root-level flags runCli handles before verbs', () => {
  for (const flag of ['-h, --help', '-V, --version']) assert.ok(cli.includes(`| \`${flag}\` |`), flag);
});
test('a const assertion names no type', () => {
  assert.deepEqual(typeReferences("export const x = Object.freeze(['a'] as const);\ntype Y = Z;"), ['Z']);
});
