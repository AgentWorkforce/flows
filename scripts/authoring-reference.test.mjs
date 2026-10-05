import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, source, declarationText, unionDeclarations, literal } from './authoring-source.mjs';

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
  assert.match(authoring, /default 30s, maximum 15m/);
});
test('done documents all three distinct completion vocabularies', () => {
  const text = read('packages/surface/src/completion.ts');
  // Independent source reader: expand array spreads using raw text, not the AST evaluator.
  const reasons = name => [...text.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))[1]
    .matchAll(/\.\.\.(\w+)|["'](\w+)["']/g)].flatMap(match => match[1] ? reasons(match[1]) : [match[2]]);
  for (const name of ['FLOW_COMPLETION_REASONS', 'RUN_COMPLETION_REASONS', 'COMPLETION_REASONS']) {
    const row = authoring.split('\n').find(line => line.startsWith(`| \`${name}\``));
    assert.ok(row);
    assert.deepEqual([...row.matchAll(/`(\w+)`/g)].slice(1).map(match => match[1]), reasons(name));
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
  assert.equal(names.length, 24);
  for (const name of names) assert.ok(cli.includes(`## flows ${name}\n`), name);
  for (const [, flag] of text.matchAll(/flags: '([^']+)'/g)) assert.ok(cli.includes(flag.replaceAll('|', '\\|')), flag);
  for (const name of ['hn-monitor start', 'tick start', 'plugin list', 'plugin verify', 'plugin remove', 'plugin update']) assert.ok(cli.includes(`## flows ${name}\n`));
  assert.match(cli, /up to|1-32/);
  assert.match(cli, /`\.relayflowd`/);
});
test('lease prose agrees with type, kernel default and compiler ceiling', () => {
  const [, seconds, minutes] = context.match(/default (\d+)s, maximum (\d+)m/);
  const kernel = read('kernel/relayflowd-core/src/machine.rs').match(/const LEASE_DURATION_MS: i64 = ([\d_]+);/)[1];
  assert.equal(Number(kernel.replaceAll('_', '')), Number(seconds) * 1000);
  const compiler = read('packages/sdk/src/compile.ts');
  assert.ok(compiler.includes(`agent ? 60 : ${minutes}} minutes`));
  assert.ok(compiler.includes(`agent ? AGENT_STEP_TIMEOUT_MAX_MS : ${minutes} * 60_000`));
  const surface = read('docs/SURFACE.md').split('### Command timeouts')[1].split('\n### ')[0];
  assert.ok(surface.includes(`default is **${seconds} seconds**`));
  assert.ok(surface.includes(`**${minutes} minutes**`));
  const readme = read('packages/surface/README.md');
  assert.ok(readme.includes(`**${seconds}s by default**`));
  assert.ok(readme.includes(`**${minutes}m maximum**`));
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
