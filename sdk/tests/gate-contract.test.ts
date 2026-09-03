import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFlow } from '../src/cli/check.js';
import { runCli } from '../src/cli.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { acceptsAnyOutput, inspectStepGate } from '../src/gate-contract.js';
import { preflight } from '../src/index.js';
import type { FlowSpec } from '../src/spec.js';
import { validateSpec } from '../src/validate.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

function schemaFixture(name: 'valid' | 'invalid'): unknown {
  return JSON.parse(readFileSync(join(TESTDATA, `json-schema-${name}.json`), 'utf8'));
}

describe('data/code gate contract', () => {
  it('describes the implicit and explicit checks the kernel will journal', () => {
    expect(inspectStepGate({
      id: 'render',
      type: 'deterministic',
      command: 'printf ready',
      verification: { type: 'output_contains', value: 'ready' },
    })).toEqual({
      stepId: 'render',
      kind: 'data',
      checks: ['exit_code', 'output_contains'],
      evaluator: 'kernel',
      preflightable: true,
      replayable: true,
    });
  });

  it('makes the preflightable gate plan visible through flows check', () => {
    const checked = checkFlow(join(TESTDATA, 'hello-deterministic.flow.yaml'));

    expect(checked.report.gates).toEqual([
      expect.objectContaining({
        stepId: 'greet',
        kind: 'data',
        checks: ['exit_code', 'output_contains'],
        preflightable: true,
        replayable: true,
      }),
      expect.objectContaining({
        stepId: 'shout',
        kind: 'data',
        checks: ['exit_code', 'output_contains'],
        preflightable: true,
        replayable: true,
      }),
    ]);
  });

  it('prints the gate plan in the human flows check report', async () => {
    const stdout: string[] = [];
    const code = await runCli(
      ['check', join(TESTDATA, 'hello-deterministic.flow.yaml')],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(stdout).toContain(
      'GATE step "greet" exit_code+output_contains from data (kernel, journal-replayable)',
    );
  });

  it('preserves v1 verification at the unchanged kernel boundary', () => {
    const flow = compileSpec({
      version: '0.1.0',
      steps: [{
        id: 'render',
        type: 'deterministic',
        command: 'printf ready',
        verification: { type: 'output_contains', value: 'ready' },
      }],
    });

    expect(toKernelSpec(flow).steps[0]?.verification).toEqual({
      output_contains: 'ready',
    });
  });

  it('does not admit an expression language into serializable verification', () => {
    const candidate = {
      version: '0.1.0',
      steps: [{
        id: 'render',
        type: 'deterministic',
        command: 'printf ready',
        verification: { type: 'expression', expression: 'length < 200' },
      }],
    };

    expect(() => compileSpec(candidate)).toThrow(
      /expected exit_code \| output_contains \| json_schema/,
    );
    expect(() => toKernelSpec(candidate as unknown as FlowSpec)).toThrow(
      /expected exit_code \| output_contains \| json_schema/,
    );
  });

  it('rejects author callbacks at both serializable compiler boundaries', () => {
    const candidate = {
      version: '0.1.0',
      steps: [{
        id: 'render',
        type: 'deterministic',
        command: 'printf ready',
        verification: (value: string): boolean => value.length < 200,
      }],
    };

    expect(() => compileSpec(candidate)).toThrow(/verification: expected JSON-compatible data/);
    expect(() => toKernelSpec(candidate as unknown as FlowSpec)).toThrow(
      /verification: expected JSON-compatible data/,
    );
  });

  it('rejects explicit exit_code gates the kernel cannot apply to llm or agent steps', () => {
    for (const step of [
      { id: 'llm', type: 'llm', prompt: 'answer', verification: { type: 'exit_code' } },
      { id: 'agent', type: 'agent', instruction: 'answer', verification: { type: 'exit_code' } },
    ]) {
      const candidate = { version: '0.1.0', steps: [step] };
      expect(() => compileSpec(candidate)).toThrow(/exit_code.*deterministic/);
      expect(() => toKernelSpec(candidate as unknown as FlowSpec)).toThrow(
        /exit_code.*deterministic/,
      );
    }
  });

  it('snapshots and freezes schema data before returning a compiled or kernel spec', () => {
    const schema = { type: 'string' };
    const candidate = {
      version: '0.1.0',
      steps: [{
        id: 'schema',
        type: 'llm',
        prompt: 'answer',
        verification: { type: 'json_schema', schema },
      }],
    };

    const compiled = compileSpec(candidate);
    schema.type = 'number';
    const compiledGate = compiled.steps[0]?.verification;
    expect(compiledGate?.type).toBe('json_schema');
    if (compiledGate?.type !== 'json_schema') throw new Error('expected schema gate');
    expect(compiledGate.schema).toEqual({ type: 'string' });
    expect(Object.isFrozen(compiledGate.schema)).toBe(true);

    const loweredGate = toKernelSpec(compiled).steps[0]?.verification.json_schema;
    expect(loweredGate).toEqual({ type: 'string' });
    expect(Object.isFrozen(loweredGate)).toBe(true);
  });

  it('rejects behavioral and non-JSON values inside schema declarations', () => {
    let accessorReads = 0;
    let toJsonCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return 'secret';
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    const schemas = [
      { type: 'string', toJSON: () => { toJsonCalls += 1; return true; } },
      { type: 'object', x_runtime: { callback: () => true } },
      { type: 'object', x_runtime: 1n },
      { type: 'object', x_runtime: accessor },
      { type: 'object', x_runtime: cyclic },
    ];
    for (const schema of schemas) {
      const candidate = {
        version: '0.1.0',
        steps: [{
          id: 'schema',
          type: 'llm',
          prompt: 'answer',
          verification: { type: 'json_schema', schema },
        }],
      };
      expect(() => compileSpec(candidate)).toThrow(/JSON-compatible data/);
      expect(() => toKernelSpec(candidate as unknown as FlowSpec)).toThrow(
        /JSON-compatible data/,
      );
    }
    expect(accessorReads).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  // Boundaries report a refusal in two shapes: `compileSpec`/`toKernelSpec`
  // throw, while `preflight` returns a named `invalid_spec` diagnostic. Both
  // are refusals; anything that returns a usable result is not, and the
  // fallback string below cannot match the assertion.
  const captureRefusal = (run: () => unknown): string => {
    try {
      const result = run() as {
        ok?: boolean;
        errors?: string[];
        diagnostics?: Array<{ message?: string }>;
      };
      if (result !== null && typeof result === 'object' && result.ok === false) {
        return [
          ...(result.errors ?? []),
          ...(result.diagnostics ?? []).map((diagnostic) => diagnostic.message ?? ''),
        ].join('; ');
      }
      return 'NOT REFUSED: the boundary accepted the input';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it('rejects proxy schemas without executing traps at any public data boundary', () => {
    for (const boundary of [
      (flow: FlowSpec) => compileSpec(flow),
      (flow: FlowSpec) => toKernelSpec(flow),
      (flow: FlowSpec) => preflight(flow, {
        probes: {
          command: () => true,
          cli: () => ({ exists: true, authenticated: true }),
          executor: () => true,
        },
      }),
    ]) {
      let proxyTraps = 0;
      const sourceSchema = { type: 'string' };
      const proxySchema = new Proxy(sourceSchema, {
        getPrototypeOf(target) {
          proxyTraps += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          proxyTraps += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          proxyTraps += 1;
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          return key === 'type' && descriptor !== undefined
            ? { ...descriptor, value: 'number' }
            : descriptor;
        },
      });
      const candidate = {
        version: '0.1.0',
        steps: [{
          id: 'schema',
          type: 'deterministic',
          command: 'printf ok',
          verification: { type: 'json_schema', schema: proxySchema },
        }],
      } as FlowSpec;

      expect(captureRefusal(() => boundary(candidate))).toMatch(/proxy/i);
      expect(proxyTraps).toBe(0);
      expect(sourceSchema.type).toBe('string');
    }
  });

  it('omits explicit undefined object properties accepted by the public types and validator', () => {
    const candidate: FlowSpec = {
      version: '0.1.0',
      description: undefined,
      steps: [{
        id: 'defined',
        type: 'deterministic',
        command: 'true',
        verification: undefined,
      }],
    };

    expect(validateSpec(candidate)).toEqual({ ok: true, errors: [] });
    const compiled = compileSpec(candidate);
    expect(compiled).not.toHaveProperty('description');
    expect(compiled.steps[0]).toMatchObject({
      id: 'defined',
      verification: { type: 'exit_code' },
    });
    expect(preflight(candidate, {
      probes: {
        command: () => true,
        cli: () => ({ exists: true, authenticated: true }),
        executor: () => true,
      },
    }).ok).toBe(true);
  });

  it('accepts both boolean JSON Schemas exactly as the kernel does', () => {
    for (const schema of [true, false]) {
      const candidate = {
        version: '0.1.0',
        steps: [{
          id: 'schema',
          type: 'llm',
          prompt: 'answer',
          verification: { type: 'json_schema', schema },
        }],
      };
      const compiled = compileSpec(candidate);
      expect(toKernelSpec(compiled).steps[0]?.verification.json_schema).toBe(schema);
    }
  });

  it('preflights the same valid and invalid JSON Schemas as the kernel', () => {
    const candidate = (schema: unknown) => ({
      version: '0.1.0',
      steps: [{
        id: 'schema',
        type: 'deterministic',
        command: 'printf ok',
        verification: { type: 'json_schema', schema },
      }],
    });

    expect(() => compileSpec(candidate(schemaFixture('valid')))).not.toThrow();
    expect(() => compileSpec(candidate(schemaFixture('invalid')))).toThrow(
      /invalid JSON Schema/,
    );

    const checked = checkFlow(join(TESTDATA, 'json-schema-invalid.flow.yaml'));
    expect(checked.report).toEqual(expect.objectContaining({
      ok: false,
      gates: [],
      diagnostics: [expect.objectContaining({
        kind: 'invalid_spec',
        message: expect.stringMatching(/invalid JSON Schema/),
      })],
    }));
  });

  // A schema that accepts every output is legal and stays legal — the kernel
  // accepts `{}` and `true` too — but it must not be reported as a gate that
  // judges something.
  describe('vacuous gates', () => {
    it.each([
      ['true', true],
      ['empty object', {}],
      ['annotations only', { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'anything' }],
    ])('classifies %s as accepting any output', (_name, schema) => {
      expect(acceptsAnyOutput(schema)).toBe(true);
      expect(inspectStepGate({
        id: 'vacuous',
        type: 'deterministic',
        command: 'printf ok',
        verification: { type: 'json_schema', schema },
      } as never)).toEqual(expect.objectContaining({ acceptsAnyOutput: true }));
    });

    it.each([
      ['a typed schema', { type: 'object' }],
      ['false', false],
      ['a schema with required', { $schema: 'https://json-schema.org/draft/2020-12/schema', required: ['a'] }],
    ])('does not flag %s', (_name, schema) => {
      expect(acceptsAnyOutput(schema)).toBe(false);
      expect(inspectStepGate({
        id: 'real',
        type: 'deterministic',
        command: 'printf ok',
        verification: { type: 'json_schema', schema },
      } as never)).not.toHaveProperty('acceptsAnyOutput');
    });

    it('warns through preflight and marks the line in flows check', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'flows-vacuous-'));
      const path = join(directory, 'vacuous.flow.yaml');
      writeFileSync(path, [
        "version: '0.1.0'",
        'name: vacuous',
        'steps:',
        '  - id: judges-nothing',
        '    type: deterministic',
        '    command: printf ok',
        '    verification:',
        '      type: json_schema',
        '      schema: true',
        '',
      ].join('\n'));
      try {
        const checked = checkFlow(path);
        expect(checked.report.gates[0]).toEqual(
          expect.objectContaining({ stepId: 'judges-nothing', acceptsAnyOutput: true }),
        );
        expect(checked.report.diagnostics).toContainEqual(expect.objectContaining({
          severity: 'warning',
          kind: 'vacuous_gate',
          stepId: 'judges-nothing',
        }));

        const stdout: string[] = [];
        const code = await runCli(['check', path], {
          stdout: (line) => stdout.push(line),
          stderr: () => {},
        });
        expect(code).toBe(0);
        expect(stdout).toContain(
          'GATE step "judges-nothing" exit_code+json_schema from data (kernel, journal-replayable)'
          + ' [json_schema accepts any output]',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
