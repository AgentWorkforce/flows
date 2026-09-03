// Kernel/SDK agreement on which JSON Schema declarations are legal.
//
// Both sides read `testdata/json-schema-bound-cases.json`. The kernel half is
// `kernel/relayflowd-core/src/schema.rs`
// (`every_refused_corpus_schema_compiles_but_is_refused_by_the_bound` and
// `every_accepted_corpus_schema_is_accepted`) plus the protocol-level
// `kernel/relayflowd/tests/invalid_schema_preflight.rs`. A schema added to the
// corpus is enforced on both sides or one of the two suites goes red.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSpec } from '../src/compile.js';
import { jsonSchemaBoundError, UNBOUNDED_REF_CYCLE } from '../src/json-schema-bound.js';
import { jsonSchemaError } from '../src/json-schema.js';
import type { FlowSpec } from '../src/spec.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

interface Case {
  name: string;
  before?: string;
  schema: boolean | Record<string, unknown>;
}
const corpus = JSON.parse(
  readFileSync(join(TESTDATA, 'json-schema-bound-cases.json'), 'utf8'),
) as { marker: string; refused: Case[]; accepted: Case[] };

const flowWith = (schema: unknown): FlowSpec =>
  ({
    version: '0.1.0',
    name: 'bound',
    steps: [
      {
        id: 's',
        type: 'deterministic',
        command: 'true',
        verification: { type: 'json_schema', schema },
      },
    ],
  }) as unknown as FlowSpec;

describe('JSON Schema termination bound', () => {
  it('shares its refusal marker with the kernel', () => {
    expect(UNBOUNDED_REF_CYCLE).toBe(corpus.marker);
  });

  // The bound, not the mechanism: this asserts the BOUND function itself, so
  // neutering the bound while leaving Ajv compilation in place fails here.
  it.each(corpus.refused.map((entry) => [entry.name, entry] as const))(
    'refuses %s',
    (_name, entry) => {
      expect(jsonSchemaBoundError(entry.schema)).toContain(UNBOUNDED_REF_CYCLE);
      expect(jsonSchemaError(entry.schema)).toContain(UNBOUNDED_REF_CYCLE);
      expect(() => compileSpec(flowWith(entry.schema))).toThrow(
        new RegExp(UNBOUNDED_REF_CYCLE.replace('$', '\\$')),
      );
    },
  );

  // The other half: without this the bound could pass by refusing everything.
  it.each(corpus.accepted.map((entry) => [entry.name, entry] as const))(
    'accepts %s',
    (_name, entry) => {
      expect(jsonSchemaBoundError(entry.schema)).toBeUndefined();
      expect(jsonSchemaError(entry.schema)).toBeUndefined();
      expect(() => compileSpec(flowWith(entry.schema))).not.toThrow();
    },
  );

  it('names the cycle it found', () => {
    const message = jsonSchemaBoundError({
      $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } },
      $ref: '#/$defs/a',
    });
    expect(message).toContain('#/$defs/a');
    expect(message).toContain('#/$defs/b');
  });

  it('does not mistake a property named $ref for a reference', () => {
    expect(
      jsonSchemaBoundError({
        type: 'object',
        properties: { $ref: { type: 'string' }, allOf: { type: 'string' } },
      }),
    ).toBeUndefined();
  });

  it('walks a deep schema with an explicit stack rather than recursion', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 5_000; depth += 1) {
      schema = { type: 'array', items: schema };
    }
    expect(jsonSchemaBoundError(schema)).toBeUndefined();
  });
});
