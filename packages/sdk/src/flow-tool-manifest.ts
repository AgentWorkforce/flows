import { canonicalize } from './canonical.js';
import { sha256 } from './bundle.js';
import { snapshotJsonValue, type JsonValue } from './json-value.js';
import { FLOW_TOOL_LIMITS, FLOW_TOOL_SCHEMA_DIALECT, flowToolSchema, compileFlowToolSchema } from './flow-tool-schema.js';
import type { FlowToolJson, FlowToolObjectSchema } from './flow-tool-schema.js';

export type FlowToolDigest = `sha256:${string}`;
export interface FlowToolDeclarationV1 {
  readonly name: string;
  readonly description: string;
  /** Author-supplied immutable bundle reference; not proof of bundle verification. */
  readonly flow: Readonly<{ name: string; version: string; digest: FlowToolDigest }>;
  readonly inputSchema: FlowToolObjectSchema;
  readonly resultSchema: FlowToolObjectSchema;
}
export interface FlowToolManifestV1 extends FlowToolDeclarationV1 {
  readonly manifestVersion: 1;
  readonly schemaDialect: typeof FLOW_TOOL_SCHEMA_DIALECT;
  /** SHA-256 of canonical manifest content excluding this field. Not a signature. */
  readonly digest: FlowToolDigest;
}

const FIELDS = ['name', 'description', 'flow', 'inputSchema', 'resultSchema'];
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function record(value: JsonValue, fields: readonly string[], at: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${at}: expected an object`);
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${at}: missing or unknown fields`);
  }
  return value;
}

function declaration(value: unknown): FlowToolDeclarationV1 {
  const data = record(snapshotJsonValue(value, 'flow tool', FLOW_TOOL_LIMITS), FIELDS, 'flow tool');
  if (typeof data.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(data.name)) {
    throw new TypeError('flow tool.name: expected a portable tool name (1–64 ASCII characters)');
  }
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 4096) {
    throw new TypeError('flow tool.description: expected 1–4096 characters of operator-authored description');
  }
  const flow = record(data.flow!, ['name', 'version', 'digest'], 'flow tool.flow');
  if (typeof flow.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(flow.name)) {
    throw new TypeError('flow tool.flow.name: expected a safe flow name');
  }
  if (typeof flow.version !== 'string' || flow.version.length > 128 || !VERSION.test(flow.version)
    || flow.version.split('+')[0]!.split('-').slice(1).join('-').split('.').some(id => /^0\d+$/.test(id))) {
    throw new TypeError('flow tool.flow.version: expected a semantic version');
  }
  if (typeof flow.digest !== 'string' || !DIGEST.test(flow.digest)) throw new TypeError('flow tool.flow.digest: expected sha256 and 64 lowercase hex digits');
  return Object.freeze({
    name: data.name, description: data.description,
    flow: Object.freeze({ name: flow.name, version: flow.version, digest: flow.digest as FlowToolDigest }),
    inputSchema: flowToolSchema(data.inputSchema, 'flow tool.inputSchema'),
    resultSchema: flowToolSchema(data.resultSchema, 'flow tool.resultSchema'),
  });
}

/** Explicit runtime contract; TypeScript generics are never treated as schemas. */
export function createFlowToolManifest(value: FlowToolDeclarationV1): FlowToolManifestV1 {
  const content = Object.freeze({ manifestVersion: 1 as const, schemaDialect: FLOW_TOOL_SCHEMA_DIALECT, ...declaration(value) });
  return snapshotJsonValue({ ...content, digest: `sha256:${sha256(canonicalize(content))}` },
    'flow tool manifest', FLOW_TOOL_LIMITS) as unknown as FlowToolManifestV1;
}

/** Verify untrusted JSON and optionally bind it to a caller-trusted catalog digest. */
export function parseFlowToolManifest(value: unknown, expectedDigest?: FlowToolDigest): FlowToolManifestV1 {
  const data = record(snapshotJsonValue(value, 'flow tool manifest', FLOW_TOOL_LIMITS),
    [...FIELDS, 'manifestVersion', 'schemaDialect', 'digest'], 'flow tool manifest');
  if (data.manifestVersion !== 1 || data.schemaDialect !== FLOW_TOOL_SCHEMA_DIALECT) {
    throw new TypeError('flow tool manifest: unsupported manifest version or schema dialect');
  }
  const parsed = createFlowToolManifest(Object.fromEntries(FIELDS.map(key => [key, data[key]])) as unknown as FlowToolDeclarationV1);
  if (data.digest !== parsed.digest || (expectedDigest !== undefined && parsed.digest !== expectedDigest)) {
    throw new TypeError('flow tool manifest: digest mismatch');
  }
  return parsed;
}

export function canonicalFlowToolManifest(value: FlowToolManifestV1): string {
  return canonicalize(parseFlowToolManifest(value));
}

function validate(value: unknown, schema: FlowToolObjectSchema, at: string): Readonly<Record<string, FlowToolJson>> {
  const snapshot = snapshotJsonValue(value, at, FLOW_TOOL_LIMITS);
  const validator = compileFlowToolSchema(schema);
  if (!validator(snapshot)) {
    // Report schema location, never data or the provider's raw response.
    throw new TypeError(`${at}: schema validation failed (${validator.errors?.[0]?.keyword ?? 'invalid'})`);
  }
  return snapshot as Readonly<Record<string, FlowToolJson>>;
}

export function validateFlowToolInput(manifest: FlowToolManifestV1, input: unknown): Readonly<Record<string, FlowToolJson>> {
  return validate(input, parseFlowToolManifest(manifest).inputSchema, 'flow tool input');
}

/** Validates structure only, not business truth or successful execution. */
export function validateFlowToolResult(manifest: FlowToolManifestV1, result: unknown): Readonly<Record<string, FlowToolJson>> {
  return validate(result, parseFlowToolManifest(manifest).resultSchema, 'flow tool result');
}
