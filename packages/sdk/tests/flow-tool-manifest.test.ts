import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createFlowToolManifest, parseFlowToolManifest, canonicalFlowToolManifest,
  validateFlowToolInput, validateFlowToolResult, type FlowToolDeclarationV1,
} from '../src/flow-tool-manifest.js';
import { flowToolFunctionDefinition, flowToolMcpDefinition } from '../src/flow-tool-definitions.js';
import { canonicalize } from '../src/canonical.js';

function declaration(): FlowToolDeclarationV1 {
  return {
    name: 'review_pull_request', description: 'Review a pinned PR; a hold verdict is not approval to merge.',
    flow: { name: 'pr-review', version: '1.2.3', digest: `sha256:${'a'.repeat(64)}` },
    inputSchema: { type: 'object', properties: { pr: { type: 'integer', minimum: 1 }, mode: { enum: ['review'] } }, required: ['pr', 'mode'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { verdict: { enum: ['hold', 'pass'] } }, required: ['verdict'], additionalProperties: false },
  };
}
// Deliberately cross the static type boundary to exercise hostile runtime input.
const unchecked = (value: unknown) => createFlowToolManifest(value as FlowToolDeclarationV1);

describe('FlowToolManifestV1', () => {
  it('creates a reproducible canonical contract and independently verifiable digest', () => {
    const manifest = createFlowToolManifest(declaration());
    const { digest, ...content } = manifest;
    expect(digest).toBe(`sha256:${createHash('sha256').update(canonicalize(content)).digest('hex')}`);
    expect(canonicalFlowToolManifest(manifest)).toBe(canonicalize(manifest));
    expect(parseFlowToolManifest(JSON.parse(canonicalFlowToolManifest(manifest)), digest)).toEqual(manifest);
    const reordered = JSON.parse(JSON.stringify(declaration())) as Record<string, unknown>;
    expect(unchecked(Object.fromEntries(Object.entries(reordered).reverse())).digest).toBe(digest);
    expect(canonicalFlowToolManifest(manifest)).not.toContain('\n');
  });

  it('snapshots and deeply freezes caller-owned metadata and schemas', () => {
    const raw = JSON.parse(JSON.stringify(declaration()));
    const manifest = unchecked(raw);
    raw.flow.digest = `sha256:${'b'.repeat(64)}`;
    raw.inputSchema.properties.pr.minimum = 100;
    expect(manifest.flow.digest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(validateFlowToolInput(manifest, { pr: 1, mode: 'review' })).toEqual({ pr: 1, mode: 'review' });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.flow)).toBe(true);
    expect(Object.isFrozen(manifest.inputSchema.properties)).toBe(true);
    expect(() => { (manifest as unknown as { name: string }).name = 'changed'; }).toThrow();
  });

  it.each(['name', 'description', 'flow', 'inputSchema', 'resultSchema'])('binds %s into the digest and refuses stale metadata', field => {
    const original = createFlowToolManifest(declaration());
    const changed = JSON.parse(JSON.stringify(original));
    if (field === 'name') changed.name = 'changed';
    if (field === 'description') changed.description = 'Changed operator metadata';
    if (field === 'flow') changed.flow.version = '2.0.0';
    if (field === 'inputSchema') changed.inputSchema.properties.pr.minimum = 2;
    if (field === 'resultSchema') changed.resultSchema.properties.verdict.enum.push('unknown');
    expect(() => parseFlowToolManifest(changed)).toThrow('digest mismatch');
    expect(() => flowToolFunctionDefinition(changed)).toThrow('digest mismatch');
    expect(() => flowToolMcpDefinition(changed)).toThrow('digest mismatch');
  });

  it('rejects an unexpected trusted digest even when the manifest is internally consistent', () => {
    expect(() => parseFlowToolManifest(createFlowToolManifest(declaration()), `sha256:${'0'.repeat(64)}`)).toThrow('digest mismatch');
  });

  it.each([
    null, [], {}, { ...declaration(), name: '' }, { ...declaration(), name: 'a.b' },
    { ...declaration(), name: 'a'.repeat(65) }, { ...declaration(), description: ' ' },
    { ...declaration(), description: 'a'.repeat(4097) }, { ...declaration(), permissions: ['admin'] },
    { ...declaration(), flow: { ...declaration().flow, digest: 'main' } },
    { ...declaration(), flow: { ...declaration().flow, digest: `sha256:${'A'.repeat(64)}` } },
    { ...declaration(), flow: { ...declaration().flow, version: 'latest' } },
    { ...declaration(), flow: { ...declaration().flow, version: '1.0.0-01' } },
    { ...declaration(), flow: { ...declaration().flow, name: '../escape' } },
  ])('rejects malformed declaration %#', value => expect(() => unchecked(value)).toThrow());

  it.each(['manifestVersion', 'schemaDialect', 'digest'])('requires valid %s', field => {
    const raw = JSON.parse(JSON.stringify(createFlowToolManifest(declaration())));
    raw[field] = 'unknown';
    expect(() => parseFlowToolManifest(raw)).toThrow();
  });

  it('never executes accessors, proxies or toJSON while constructing identity', () => {
    let executed = 0;
    const getter = { ...declaration(), get description() { executed++; return 'attacker'; } };
    expect(() => unchecked(getter)).toThrow('accessors');
    expect(() => unchecked(new Proxy(declaration(), { ownKeys() { executed++; return []; } }))).toThrow('Proxy');
    expect(() => unchecked({ ...declaration(), toJSON() { executed++; return {}; } })).toThrow();
    expect(executed).toBe(0);
  });
});

describe('explicit input and result schema boundary', () => {
  it('validates without coercion, defaults, removal or mutation; a hold result remains valid', () => {
    const manifest = createFlowToolManifest(declaration());
    const input = { pr: 42, mode: 'review' };
    const snapshot = validateFlowToolInput(manifest, input);
    expect(snapshot).toEqual(input);
    expect(snapshot).not.toBe(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(validateFlowToolResult(manifest, { verdict: 'hold' })).toEqual({ verdict: 'hold' });
    expect(() => validateFlowToolInput(manifest, { pr: '42', mode: 'review' })).toThrow();
  });

  it.each([{}, null, [], { pr: 0, mode: 'review' }, { pr: 1.5, mode: 'review' }, { pr: 1, mode: 'merge' }, { pr: 1, mode: 'review', authority: 'admin' }])('refuses invalid root input %#', value => {
    expect(() => validateFlowToolInput(createFlowToolManifest(declaration()), value)).toThrow('flow tool input');
  });

  it.each([{}, null, { verdict: 'completed' }, { verdict: 'pass', secret: 'secret-fixture' }])('refuses invalid result %# without echoing data', value => {
    try { validateFlowToolResult(createFlowToolManifest(declaration()), value); throw new Error('accepted'); }
    catch (error) { expect(String(error)).toContain('flow tool result'); expect(String(error)).not.toContain('secret-fixture'); }
  });

  it.each([
    true, false, { type: 'array' }, { type: 'object', typo: true },
    { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' },
    { type: 'object', $ref: 'https://example.invalid/schema' },
    { type: 'object', $ref: '#/$defs/missing' },
    { type: 'object', properties: { x: { type: 'string', format: 'email' } } },
    { type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } },
    { type: 'object', properties: { x: { type: 'string', default: 'not-applied' } } },
    { type: 'object', required: ['undeclared'] },
    { type: 'object', $defs: { loop: { $ref: '#/$defs/loop' } }, $ref: '#/$defs/loop' },
  ])('fails closed on unsupported/invalid schema %#', schema => {
    expect(() => unchecked({ ...declaration(), inputSchema: schema })).toThrow();
    expect(() => unchecked({ ...declaration(), resultSchema: schema })).toThrow();
  });

  it('supports closed nested objects, local definitions, arrays, bounds and nullable unions', () => {
    const schema = { type: 'object', $defs: { row: { type: 'object', properties: { label: { type: ['string', 'null'], minLength: 1 } }, required: ['label'], additionalProperties: false } }, properties: { rows: { type: 'array', items: { $ref: '#/$defs/row' }, minItems: 1, maxItems: 2 } }, required: ['rows'], additionalProperties: false };
    const manifest = unchecked({ ...declaration(), inputSchema: schema });
    expect(validateFlowToolInput(manifest, { rows: [{ label: null }, { label: 'x' }] })).toBeDefined();
    for (const value of [{ rows: [] }, { rows: [{ label: '' }] }, { rows: [{ label: 'x', extra: true }] }]) {
      expect(() => validateFlowToolInput(manifest, value)).toThrow();
    }
  });

  it('bounds non-JSON, cyclic, oversized and excessively deep runtime values', () => {
    const manifest = unchecked({ ...declaration(), inputSchema: { type: 'object' } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: unknown = {}; for (let i = 0; i < 70; i++) deep = { child: deep };
    for (const input of [{ x: NaN }, { x: BigInt(1) }, { x: new Date() }, cycle, deep, { text: 'x'.repeat(262145) }, { list: new Array(5000).fill(0) }]) {
      expect(() => validateFlowToolInput(manifest, input)).toThrow();
    }
  });
});

describe('metadata adapters', () => {
  it('emits standard definitions with exact schema parity and no invented execution claims', () => {
    const manifest = createFlowToolManifest(declaration());
    const native = flowToolFunctionDefinition(manifest), mcp = flowToolMcpDefinition(manifest);
    expect(native).toEqual({ type: 'function', name: manifest.name, description: manifest.description, parameters: manifest.inputSchema });
    expect(mcp).toEqual({ name: manifest.name, description: manifest.description, inputSchema: manifest.inputSchema, outputSchema: manifest.resultSchema });
    expect(ToolSchema.parse(mcp)).toEqual(mcp);
    expect(Object.isFrozen(native.parameters)).toBe(true);
    expect(Object.isFrozen(mcp.outputSchema)).toBe(true);
    expect(mcp).not.toHaveProperty('annotations');
    expect(native).not.toHaveProperty('strict');
  });
});
