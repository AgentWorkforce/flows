import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const schemaText = readFileSync(new URL('../flows.schema.json', import.meta.url), 'utf8');
const schema = JSON.parse(schemaText);
const require = createRequire(new URL('../../sdk/package.json', import.meta.url));
const ts = require('typescript');

test('all exported spec type nodes have documented definitions', () => {
  const source = ts.createSourceFile('spec.ts', readFileSync(new URL('../../sdk/src/spec.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  for (const node of source.statements) {
    if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
    expect(schema.$defs[node.name.text], node.name.text).toBeDefined();
  }
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    expect(typeof node.title).toBe('string');
    expect(node.title.length).toBeGreaterThan(0);
    expect(typeof node.description).toBe('string');
    expect(node.description.length).toBeGreaterThan(0);
    if (node.$ref) {
      expect(node.$ref.startsWith('#/')).toBe(true);
      let value: any = schema;
      for (const key of node.$ref.slice(2).split('/')) value = value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
      expect(value, node.$ref).toBeDefined();
    }
    for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) Object.values(node[key] ?? {}).forEach(walk);
    for (const key of ['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) walk(node[key]);
    for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) (node[key] ?? []).forEach(walk);
  }
  walk(schema);
  expect(schema.$defs.StepSpec.oneOf.map((arm: any) => schema.$defs[arm.$ref.split('/').at(-1)].properties.type.const)).toEqual(['deterministic', 'llm', 'agent']);
});

test('regeneration is byte-stable and committed schema has not drifted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relayflows-schema-regen-'));
  try {
    const first = join(directory, 'first.json');
    const second = join(directory, 'second.json');
    const script = fileURLToPath(new URL('../../../scripts/generate-json-schema.mjs', import.meta.url));
    execFileSync('node', [script, first]);
    execFileSync('node', [script, second]);
    expect(readFileSync(first, 'utf8')).toBe(readFileSync(second, 'utf8'));
    expect(readFileSync(first, 'utf8')).toBe(schemaText);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('npm tarball contains only data and documentation with no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
  expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
  expect(pkg.main).toBe('./flows.schema.json');
  expect(pkg.exports['.']).toBe('./flows.schema.json');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageDirectory, encoding: 'utf8' }));
  expect(packed[0].files.map((file: any) => file.path).sort()).toEqual(['LICENSE', 'README.md', 'THIRD_PARTY_LICENSES', 'flows.schema.json', 'package.json'].sort());
});
