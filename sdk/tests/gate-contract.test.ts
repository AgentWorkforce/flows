import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFlow } from '../src/cli/check.js';
import { runCli } from '../src/cli.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { classifyGate, inspectStepGate } from '../src/gate-contract.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

describe('data/code gate contract', () => {
  it('marks named data gates as preflightable and journal-replayable', () => {
    expect(classifyGate({ type: 'output_contains', value: 'ready' })).toEqual({
      kind: 'data',
      checks: ['output_contains'],
      evaluator: 'kernel',
      preflightable: true,
      replayable: true,
    });
  });

  it('keeps author callbacks in the runtime and out of serializable gate data', () => {
    const predicate = (value: string): boolean => value.length < 200;
    const classification = classifyGate(predicate);

    expect(classification).toEqual({
      kind: 'code',
      evaluator: 'author_runtime',
      preflightable: false,
      replayable: false,
    });
    expect(JSON.stringify(classification)).not.toContain(predicate.toString());
  });

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
    expect(() => compileSpec({
      version: '0.1.0',
      steps: [{
        id: 'render',
        type: 'deterministic',
        command: 'printf ready',
        verification: { type: 'expression', expression: 'length < 200' },
      }],
    })).toThrow(/expected exit_code \| output_contains \| json_schema/);
  });
});
