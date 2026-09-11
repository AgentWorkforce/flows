import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { checkFlow } from '../../sdk/src/cli/check.ts';
import { compileSpec, CompileError } from '../../sdk/src/compile.ts';
import { jsonSchemaBoundError } from '../../sdk/src/json-schema-bound.ts';

const require = createRequire(new URL('../../sdk/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020.js').default;
const { parse } = require('yaml');
const schema = JSON.parse(readFileSync(new URL('../flows.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
const root = mkdtempSync(join(tmpdir(), 'relayflows-schema-'));
mkdirSync(join(root, 'preflight'));
mkdirSync(join(root, 'bin'));
// Real checkFlow, isolated executable probes. Fixture YAML is copied unchanged;
// every check must agree, including environment readiness (no ignored refusals).
const wrapper = '#!/bin/sh\nif [ "$1" = "--relayflows-adapter-v1" ]; then echo relayflows-agent-cli-v1; fi\nexit 0\n';
for (const file of ['preflight/authenticated-cli', 'preflight/analyze-story-claude-cli', 'bin/claude']) writeFileSync(join(root, file), wrapper, { mode: 0o755 });
writeFileSync(join(root, 'flows.json'), readFileSync(new URL('../../../testdata/flows.json', import.meta.url)));
const oldPath = process.env.PATH;
process.env.PATH = `${join(root, 'bin')}:${oldPath ?? ''}`;
afterAll(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); });
function checkSource(name: string, source: string) {
  const file = join(root, name);
  writeFileSync(file, source);
  return checkFlow(file).report;
}
const fixtures = readdirSync(new URL('../../../testdata/', import.meta.url)).filter(name => name.endsWith('.flow.yaml')).sort();
for (const name of fixtures) test(`flows check fixture parity: ${name}`, () => {
  const source = readFileSync(new URL(`../../../testdata/${name}`, import.meta.url), 'utf8');
  const accepted = validate(parse(source));
  const errors = structuredClone(validate.errors);
  const report = checkSource(name, source);
  expect(accepted, JSON.stringify({ errors, report })).toBe(report.ok);
  if (!accepted) {
    expect(name).toBe('json-schema-invalid.flow.yaml');
    expect(errors.some((error: { instancePath: string }) => error.instancePath === '/steps/0/verification/schema/type')).toBe(true);
    const refusal = report.diagnostics.find(d => d.kind === 'invalid_spec');
    expect(JSON.stringify(refusal)).toContain('spec.steps[0].verification.schema');
    expect(JSON.stringify(refusal)).toContain('type');
  }
});

const flow = (step: Record<string, unknown>) => ({ version: '0.1.0', steps: [{ id: 'one', type: 'deterministic', command: 'echo hello', ...step }] });
const cases: Array<[string, unknown, boolean]> = [
  ['unknown root key', { ...flow({}), identitty: 'chief' }, false],
  ['unsupported version', { ...flow({}), version: '0.2.0' }, false],
  ['no steps', { version: '0.1.0', steps: [] }, false],
  ['step typo', flow({ timeotMs: 10 }), false],
  ['empty command', flow({ command: '' }), false],
  ['positive timeout', flow({ timeoutMs: 0 }), false],
  ['fractional retry', flow({ maxIterations: 1.5 }), false],
  ['wrong step field', flow({ prompt: 'hello' }), false],
  ['nonzero exit gate', flow({ verification: { type: 'exit_code', expect: 1 } }), false],
  ['legacy zero exit gate', flow({ verification: { type: 'exit_code', expect: 0 } }), true],
  ['boolean schema', flow({ verification: { type: 'json_schema', schema: false } }), true],
  ['nested invalid schema', flow({ verification: { type: 'json_schema', schema: { properties: { a: { type: 'typo' } } } } }), false],
  ['bad memory budget', flow({ memory: { scope: 'script', query: 'lessons', budget: { maxTokensIn: -1 } } }), false],
  ['unsafe memory budget', flow({ memory: { scope: 'script', query: 'lessons', budget: { maxTokensIn: 9007199254740992 } } }), false],
  ['empty memory query', flow({ memory: { scope: 'script', query: '  ', budget: {} } }), false],
  ['unsafe duration', flow({ requirements: { expectedDurationMs: 9007199254740992 } }), false],
  ['bad money', { ...flow({}), budget: { maxDollars: 1.5 } }, false],
  ['bad input index', flow({ input: { a: { step: 'one', path: [-1] } } }), false],
  ['blank input name', flow({ input: { ' ': { step: 'one' } } }), false],
  ['trigger silence budget', { ...flow({}), triggers: [{ id: 'tick', executor: 'worker', staleAfterMs: 0 }] }, false],
];
for (const type of ['llm', 'agent']) {
  const step = { id: 'one', type, [type === 'llm' ? 'prompt' : 'instruction']: 'hello' };
  for (const [label, fields, ok] of [
    ['output object', { output: { type: 'object' } }, true],
    ['boolean output', { output: true }, false],
    ['output and verification', { output: {}, verification: { type: 'output_contains', value: 'hello' } }, false],
    ['exit gate', { verification: { type: 'exit_code' } }, false],
    ['trimmed model', { model: ' model ' }, false],
    ['control in model', { model: 'a\nb' }, false],
  ] as const) cases.push([`${type}: ${label}`, { version: '0.1.0', steps: [{ ...step, ...fields }] }, ok]);
}
for (const [name, value, expected] of cases) test(`structural parity: ${name}`, () => {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(expected);
  let errors: string[] = [];
  try { compileSpec(value); } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    errors = error.errors;
  }
  expect(errors.length === 0, errors.join('\n')).toBe(expected);
});

test('step examples compile and validate', () => {
  for (const name of ['DeterministicStepSpec', 'LlmStepSpec', 'AgentStepSpec']) for (const step of schema.$defs[name].examples) {
    const value = { version: '0.1.0', steps: [step] };
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(() => compileSpec(value)).not.toThrow();
  }
});
test('generated schema satisfies the existing bounded-reference rule', () => {
  expect(jsonSchemaBoundError(schema)).toBeUndefined();
});
test('semantic checks remain explicit runtime responsibilities', () => {
  for (const value of [flow({ dependsOn: ['missing'] }), flow({ verification: { type: 'json_schema', schema: { $ref: '#' } } })]) {
    expect(validate(value)).toBe(true);
    expect(() => compileSpec(value)).toThrow(CompileError);
  }
});
for (const draft of ['http://json-schema.org/draft-04/schema#', 'http://json-schema.org/draft-06/schema#', 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) test(`embedded dialect ${draft}`, () => {
  for (const type of ['string', 'typo']) {
    const value = flow({ verification: { type: 'json_schema', schema: { $schema: draft, properties: { result: { type } } } } });
    expect(validate(value)).toBe(type === 'string');
    if (type === 'string') expect(() => compileSpec(value)).not.toThrow();
    else expect(() => compileSpec(value)).toThrow(CompileError);
  }
});
test('header hint is warning-only, first-line aware, and never edits input', () => {
  const source = JSON.stringify(flow({}));
  const header = '# yaml-language-server: $schema=./flows.schema.json\n';
  for (const [name, input, warning] of [
    ['no-header.flow.yaml', source, true], ['header.flow.yaml', header + source, false],
    ['bom.flow.yaml', '\uFEFF' + header + source, false], ['crlf.flow.yaml', header.replace('\n', '\r\n') + source, false],
    ['later.flow.yaml', '# other comment\n' + header + source, true], ['json.flow.json', source, false],
  ] as const) {
    const report = checkSource(name, input);
    expect(report.ok).toBe(true);
    const hints = report.diagnostics.filter(d => d.kind === 'editor_schema_missing');
    expect(hints.length).toBe(warning ? 1 : 0);
    if (warning) {
      expect(hints[0].severity).toBe('warning');
      expect(hints[0].message).toContain(schema.$id);
    }
    expect(readFileSync(join(root, name), 'utf8')).toBe(input);
  }
  expect(checkSource('invalid.flow.yaml', 'steps: [').diagnostics.some(d => d.kind === 'editor_schema_missing')).toBe(true);
});

for (const [path, accepted] of [
  ['repo', true], ['/repo/src', true], ['pr://github/example', true], ['/', true], ['pr://', true],
  ['', false], [' repo', false], ['repo ', false], ['repo//src', false], ['repo/../src', false], ['repo/.', false], [':/bad//path', false],
] as const) test(`canonical surface parity: ${JSON.stringify(path)}`, () => {
  const value = { version: '0.1.0', steps: [{ id: 'one', type: 'agent', instruction: 'edit', surfaces: { workspace: [{ surface: path }], external: [path] } }] };
  expect(validate(value)).toBe(accepted);
  if (accepted) expect(() => compileSpec(value)).not.toThrow();
  else expect(() => compileSpec(value)).toThrow(CompileError);
});

test('named declarations and selected input paths use authoring shapes', () => {
  const value = { version: '0.1.0', agents: { reviewer: { cli: 'claude', model: 'review-model' } }, steps: [
    { id: 'source', type: 'llm', prompt: 'Return results', output: { type: 'object', properties: { rows: { type: 'array', items: { type: 'string' } } } } },
    { id: 'review', type: 'agent', agent: 'reviewer', instruction: 'Review the row', input: { row: { step: 'source', path: ['rows', 0] } } },
  ] };
  expect(validate(value)).toBe(true);
  expect(() => compileSpec(value)).not.toThrow();
  for (const declaration of [{ cli: 'claude' }, { cli: 'claude', model: 'ok', persona: 'extra' }, { cli: ' claude', model: 'ok' }]) {
    const invalid = { ...value, agents: { reviewer: declaration } };
    expect(validate(invalid)).toBe(false);
    expect(() => compileSpec(invalid)).toThrow(CompileError);
  }
});
