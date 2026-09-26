import Ajv2020 from 'ajv/dist/2020.js';
import { jsonSchemaBoundError } from './json-schema-bound.js';
import { snapshotJsonValue, type JsonValue } from './json-value.js';

export const FLOW_TOOL_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const;
export type FlowToolJson = null | boolean | number | string | readonly FlowToolJson[]
  | { readonly [key: string]: FlowToolJson };
export type FlowToolObjectSchema = Readonly<Record<string, FlowToolJson>> & { readonly type: 'object' };
export const FLOW_TOOL_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 4096, maxBytes: 262144 });

// A deliberately explicit portable v1 profile, not silently ignored JSON Schema.
const KEYWORDS = new Set([
  '$schema', '$defs', '$ref', 'title', 'description', 'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'anyOf', 'oneOf', 'allOf', 'not',
]);

function inspect(schema: JsonValue, at: string): void {
  if (typeof schema === 'boolean') return;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`${at}: expected a JSON Schema object or boolean`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) throw new TypeError(`${at}: unsupported v1 schema keyword ${key}`);
    if (key === '$schema' && value !== FLOW_TOOL_SCHEMA_DIALECT) {
      throw new TypeError(`${at}: expected JSON Schema 2020-12`);
    }
    if (key === '$ref' && (typeof value !== 'string' || !value.startsWith('#/'))) {
      throw new TypeError(`${at}: only document-local JSON Pointer references are supported`);
    }
    if (key === 'properties' || key === '$defs') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${at}.${key}: expected an object`);
      }
      for (const [name, child] of Object.entries(value)) inspect(child, `${at}.${key}.${name}`);
    } else if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      inspect(value, `${at}.${key}`);
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (!Array.isArray(value)) throw new TypeError(`${at}.${key}: expected an array`);
      value.forEach((child, i) => inspect(child, `${at}.${key}[${i}]`));
    }
  }
}

export function compileFlowToolSchema(schema: FlowToolObjectSchema) {
  // No coercion, defaults, removal of extras, network retrieval, or ignored formats.
  // Deliberately revalidate each supplied manifest; no unbounded global schema cache.
  // A future admitted catalog may own a bounded compiled-validator lifecycle.
  return new Ajv2020({ strict: true, strictRequired: true, allowUnionTypes: true, allErrors: false })
    .compile(schema);
}

export function flowToolSchema(value: unknown, at: string): FlowToolObjectSchema {
  const snapshot = snapshotJsonValue(value, at, FLOW_TOOL_LIMITS);
  inspect(snapshot, at);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.type !== 'object') {
    throw new TypeError(`${at}: tool schemas must explicitly have type "object"`);
  }
  const bounded = jsonSchemaBoundError(snapshot);
  if (bounded !== undefined) throw new TypeError(`${at}: ${bounded}`);
  const schema = snapshot as FlowToolObjectSchema;
  try { compileFlowToolSchema(schema); }
  catch { throw new TypeError(`${at}: invalid or unsupported JSON Schema`); }
  return schema;
}
