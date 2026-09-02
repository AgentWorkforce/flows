import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFlow } from '../src/cli/check.js';
import { runCli } from '../src/cli.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { inspectStepGate } from '../src/gate-contract.js';
import type { FlowSpec } from '../src/spec.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

function schemaFixture(name: 'valid' | 'invalid'): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TESTDATA, `json-schema-${name}.json`), 'utf8')) as Record<string, unknown>;
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

    expect(() => compileSpec(candidate)).toThrow(/verification: expected an object/);
    expect(() => toKernelSpec(candidate as unknown as FlowSpec)).toThrow(
      /verification: expected an object/,
    );
  });

  it('preflights the same valid and invalid JSON Schemas as the kernel', () => {
    const candidate = (schema: Record<string, unknown>) => ({
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
});
