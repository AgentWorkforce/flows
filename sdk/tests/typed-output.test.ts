import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  compileSpec,
  compileYaml,
  compileYamlToCanonicalJson,
  CompileError,
  toKernelSpec,
} from '../src/compile.js';
import type {
  AgentStepSpec,
  JsonOutputSchema,
  LlmStepSpec,
  OutputFromSchema,
} from '../src/spec.js';

interface Extraction {
  actionable: boolean;
  request: string;
}

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

const extractionSchema: JsonOutputSchema<Extraction> = {
  type: 'object',
  additionalProperties: false,
  required: ['actionable', 'request'],
  properties: {
    actionable: { type: 'boolean' },
    request: { type: 'string' },
  },
};

describe('typed llm and agent outputs', () => {
  it('carries a schema output type for TypeScript gates', () => {
    expectTypeOf<OutputFromSchema<typeof extractionSchema>>().toEqualTypeOf<Extraction>();

    const llm: LlmStepSpec<Extraction> = {
      id: 'extract',
      type: 'llm',
      prompt: 'Extract the request.',
      output: extractionSchema,
    };
    const agent: AgentStepSpec<Extraction> = {
      id: 'research',
      type: 'agent',
      instruction: 'Research the request.',
      output: extractionSchema,
    };

    expectTypeOf(llm.output).toEqualTypeOf<JsonOutputSchema<Extraction> | undefined>();
    expectTypeOf(agent.output).toEqualTypeOf<JsonOutputSchema<Extraction> | undefined>();
  });

  it.each(['llm', 'agent'] as const)(
    'compiles %s output sugar to the existing json_schema primitive',
    (type) => {
      const source = {
        version: '0.1.0',
        steps: [{
          id: 'typed',
          type,
          ...(type === 'llm' ? { prompt: 'Return JSON.' } : { instruction: 'Return JSON.' }),
          output: extractionSchema,
        }],
      };

      const compiled = compileSpec(source);
      expect(compiled.steps[0]).not.toHaveProperty('output');
      expect(compiled.steps[0]?.verification).toEqual({
        type: 'json_schema',
        schema: extractionSchema,
      });
      expect(toKernelSpec(compiled).steps[0]?.verification).toEqual({
        json_schema: extractionSchema,
      });
    },
  );

  it('accepts the output declaration in YAML', () => {
    const compiled = compileYaml(`
version: '0.1.0'
steps:
  - id: extract
    type: llm
    prompt: Return JSON.
    output:
      type: object
      required: [answer]
      properties:
        answer: { type: number }
`);

    expect(compiled.steps[0]?.verification).toEqual({
      type: 'json_schema',
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'number' } },
      },
    });
  });

  it('keeps the canonical hn-monitor kernel step unchanged', () => {
    const yaml = readFileSync(join(TESTDATA, 'hn-monitor.flow.yaml'), 'utf8');
    const compiled = JSON.parse(compileYamlToCanonicalJson(yaml)) as { steps: unknown[] };
    const canonical = JSON.parse(
      readFileSync(join(TESTDATA, 'hn-monitor.spec.canonical.json'), 'utf8'),
    ) as { steps: unknown[] };

    // Trigger key normalization is a separate pre-existing surface gap; this
    // assertion is deliberately about the step boundary changed in this PR.
    expect(compiled.steps).toEqual(canonical.steps);
  });

  it.each([
    { type: 'output_contains', value: 'done' },
    { type: 'json_schema', schema: extractionSchema },
  ])('fails closed when output conflicts with verification ($type)', (verification) => {
    expect(() => compileSpec({
      version: '0.1.0',
      steps: [{
        id: 'ambiguous',
        type: 'agent',
        instruction: 'Return JSON.',
        output: extractionSchema,
        verification,
      }],
    })).toThrowError(CompileError);

    try {
      compileSpec({
        version: '0.1.0',
        steps: [{
          id: 'ambiguous',
          type: 'agent',
          instruction: 'Return JSON.',
          output: extractionSchema,
          verification,
        }],
      });
    } catch (error) {
      expect((error as CompileError).errors).toContain(
        'spec.steps[0]: output already declares json_schema verification; remove verification',
      );
    }
  });

  it.each([null, [], 'not-a-schema'])(
    'fails closed on a non-object output schema (%j)',
    (output) => {
      const result = (() => {
        try {
          compileSpec({
            version: '0.1.0',
            steps: [{ id: 'bad', type: 'llm', prompt: 'Return JSON.', output }],
          });
          return null;
        } catch (error) {
          return error as CompileError;
        }
      })();

      expect(result).toBeInstanceOf(CompileError);
      expect(result?.errors).toContain('spec.steps[0].output: expected a JSON Schema object');
    },
  );
});
