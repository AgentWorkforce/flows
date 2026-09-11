import Ajv from 'ajv';
import AjvDraft4 from 'ajv-draft-04';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import draft6MetaSchema from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' };
import { jsonSchemaBoundError } from './json-schema-bound.js';
import { snapshotJsonValue, type JsonValue } from './json-value.js';

const DRAFT_4 = 'http://json-schema.org/draft-04/schema';
const DRAFT_6 = 'http://json-schema.org/draft-06/schema';
const DRAFT_7 = 'http://json-schema.org/draft-07/schema';
const DRAFT_2019_09 = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** Compile a declaration with the same drafts accepted by the kernel. */
export function jsonSchemaError(schema: boolean | Record<string, unknown>): string | undefined {
  // Termination first: a schema whose $ref graph cycles without consuming
  // input compiles fine here and aborts the kernel at verification time. Ajv's
  // own overflow is a catchable RangeError, so the authoring path happened to
  // hold for one shape of this bug and not for others; the explicit bound is
  // what makes SDK and kernel agree. See sdk/src/json-schema-bound.ts.
  const unbounded = jsonSchemaBoundError(schema);
  if (unbounded !== undefined) return unbounded;
  try {
    compileSchema(schema);
    return undefined;
  } catch (error) {
    // A RangeError here is Ajv exhausting its own JS stack while COMPILING,
    // not a verdict about the schema. The bound above has already proved this
    // declaration terminates, and the kernel -- which is the engine that
    // actually validates outputs -- accepts and runs it. Reporting Ajv's stack
    // as `invalid JSON Schema: Maximum call stack size exceeded` would refuse a
    // legal schema, leak an engine-internal message as if it were a named
    // refusal kind, and put legality back in the hands of an engine's
    // accidental overflow behaviour -- which is the precise defect the shared
    // rule and corpus exist to remove. The rule decides legality; Ajv decides
    // only well-formedness, and a stack overflow is neither verdict.
    if (error instanceof RangeError) return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}

export function snapshotJsonSchema(schema: unknown, at: string): boolean | Record<string, JsonValue> {
  const snapshot = snapshotJsonValue(schema, at);
  if (typeof snapshot === 'boolean') return snapshot;
  if (snapshot !== null && !Array.isArray(snapshot) && typeof snapshot === 'object') return snapshot;
  throw new Error(`${at}: expected a JSON Schema object or boolean`);
}

function compileSchema(schema: boolean | Record<string, unknown>) {
  const dialect = typeof schema === 'object' && typeof schema['$schema'] === 'string'
    ? schema['$schema'].replace(/#$/, '')
    : DRAFT_2020_12;
  const options = { strict: false, allErrors: true } as const;
  if (dialect === DRAFT_4) {
    return new AjvDraft4(options).compile(schema);
  } else if (dialect === DRAFT_6) {
    const validator = new Ajv(options);
    validator.addMetaSchema(draft6MetaSchema);
    return validator.compile(schema);
  } else if (dialect === DRAFT_7) {
    return new Ajv(options).compile(schema);
  } else if (dialect === DRAFT_2019_09) {
    return new Ajv2019(options).compile(schema);
  } else {
    // Ajv reports unknown dialect identifiers instead of guessing.
    return new Ajv2020(options).compile(schema);
  }
}

/** A worker verdict; the kernel independently verifies the same schema. */
export function jsonSchemaOutputError(schema: boolean | Record<string, unknown>, output: unknown): string | undefined {
  const invalid = jsonSchemaError(schema);
  if (invalid !== undefined) return invalid;
  try {
    const validate = compileSchema(schema);
    return validate(output) ? undefined : JSON.stringify(validate.errors);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
