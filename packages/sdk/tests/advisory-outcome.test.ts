// Advisory deterministic outcomes: `onNonZero: 'record'` and the `steps_green`
// gate that reads what it records.
//
// The point of the feature is that a red command stays LEGIBLE. `|| true`
// discards the exit code, so the two things these tests hold onto are: the
// policy never silently defaults when it is misspelled, and a gate that claims
// to read recorded outcomes is refused unless it actually can.

import { describe, expect, it } from 'vitest';
import { CompileError, compileSpec, toKernelSpec } from '../src/compile.js';
import { inspectStepGate } from '../src/gate-contract.js';
import { lowerStepsGreenGates } from '../src/steps-green.js';
import { runCli } from '../src/cli.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowSpec, StepSpec } from '../src/spec.js';
import { validateSpec } from '../src/validate.js';

function flow(steps: unknown[]): unknown {
  return { version: '0.1.0', name: 'advisory', steps };
}

function errors(steps: unknown[]): string[] {
  return validateSpec(flow(steps)).errors;
}

const recordingCheck = {
  id: 'check', type: 'deterministic', command: 'npm test', onNonZero: 'record',
} as const;

describe('onNonZero policy', () => {
  it('accepts both spellings and refuses every other one', () => {
    expect(errors([{ ...recordingCheck, onNonZero: 'fail' }])).toEqual([]);
    expect(errors([recordingCheck])).toEqual([]);
    for (const value of ['ignore', 'true', 'RECORD', '', 0, null, ['record']]) {
      expect(errors([{ ...recordingCheck, onNonZero: value }]))
        .toContain('spec.steps[0].onNonZero: expected fail | record');
    }
  });

  // The step-field allowlist is per type, so the policy must not leak onto a
  // worker step, which has no exit code of its own to record.
  it('refuses the policy on llm and agent steps', () => {
    expect(errors([{ id: 'a', type: 'llm', prompt: 'hi', onNonZero: 'record' }]).join('\n'))
      .toMatch(/onNonZero/);
    expect(errors([{ id: 'a', type: 'agent', instruction: 'hi', onNonZero: 'record' }]).join('\n'))
      .toMatch(/onNonZero/);
  });

  it('lowers only the non-default policy into the kernel dialect', () => {
    const kernel = toKernelSpec(compileSpec(flow([recordingCheck]) as FlowSpec));
    expect(kernel.steps[0]).toMatchObject({ on_non_zero: 'record' });

    const explicitDefault = toKernelSpec(compileSpec(
      flow([{ ...recordingCheck, onNonZero: 'fail' }]) as FlowSpec));
    expect(explicitDefault.steps[0]).not.toHaveProperty('on_non_zero');
  });

  // Recording changes what a positive exit code MEANS, not which checks run.
  // Reporting it as an ordinary exit_code gate would move the `|| true`
  // ambiguity into the inspection output.
  it('reports the recording policy alongside the checks it does not change', () => {
    expect(inspectStepGate(recordingCheck as StepSpec)).toEqual({
      stepId: 'check', kind: 'data', checks: ['exit_code'],
      evaluator: 'kernel', preflightable: true, replayable: true,
      recordsNonZeroExit: true,
    });
    expect(inspectStepGate({ id: 'check', type: 'deterministic', command: 'npm test' }))
      .not.toHaveProperty('recordsNonZeroExit');
  });

  it('annotates the recording step in flows check output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisory-check-'));
    try {
      const path = join(dir, 'advisory.yaml');
      writeFileSync(path, "version: '0.1.0'\nname: advisory\nsteps:\n"
        + '  - id: check\n    type: deterministic\n    command: npm test\n    onNonZero: record\n');
      const out: string[] = [];
      const code = await runCli(['check', path], { stdout: (line) => out.push(line), stderr: (line) => out.push(line) });
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('GATE step "check" exit_code from data (kernel, journal-replayable) [onNonZero: record]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('steps_green gate shape', () => {
  const green = (ids: unknown) => [
    recordingCheck,
    { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids } },
  ];

  it('accepts a gate over an earlier recording step', () => {
    expect(errors(green(['check']))).toEqual([]);
  });

  it('refuses an empty, non-array, blank or duplicated id list', () => {
    for (const ids of [[], 'check', [''], ['  '], [1]]) {
      expect(errors(green(ids)).join('\n'))
        .toContain('gate_ids_invalid: expected a non-empty array of step ids');
    }
    expect(errors(green(['check', 'check'])).join('\n'))
      .toContain('gate_ids_invalid: step ids must be unique');
  });

  it('refuses unknown keys on the gate', () => {
    const errs = errors([
      recordingCheck,
      { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids: ['check'], expect: 0 } },
    ]);
    expect(errs.join('\n')).toMatch(/expect/);
  });

  it('names steps_green in the unknown-gate refusal', () => {
    expect(errors([{ id: 'a', type: 'deterministic', command: 'true', verification: { type: 'vibes' } }]).join('\n'))
      .toContain('json_schema | steps_green | references_input');
  });

  it('refuses a worker host, which has no recorded exit code', () => {
    expect(errors([
      recordingCheck,
      { id: 'gate', type: 'agent', instruction: 'judge', verification: { type: 'steps_green', ids: ['check'] } },
    ]).join('\n')).toContain('gate_host_unsupported: steps_green is supported only on deterministic steps');
  });
});

describe('steps_green references', () => {
  const withGate = (ids: string[], ...before: unknown[]) => [
    ...before,
    { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids } },
  ];

  it('refuses an unknown id', () => {
    expect(errors(withGate(['nope'], recordingCheck)).join('\n'))
      .toContain('gate_source_unsupported: unknown step "nope"');
  });

  // A forward reference reads an outcome that does not exist yet; a self
  // reference reads the gate's own, which is not written until it passes.
  it('refuses forward and self references', () => {
    expect(errors([
      { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids: ['check'] } },
      recordingCheck,
    ]).join('\n')).toContain('must precede this step');
    expect(errors(withGate(['gate'])).join('\n')).toContain('must precede this step');
  });

  it('refuses a worker source, which records no exit code', () => {
    expect(errors(withGate(['write'], { id: 'write', type: 'agent', instruction: 'work' })).join('\n'))
      .toContain('gate_source_unsupported: source "write" is a agent step and records no exit code');
  });

  // The gate binds the source's whole envelope, and `output_contains` is the
  // one gate the compiler cannot widen without deleting the author's check.
  it('refuses an output_contains source rather than silently weakening it', () => {
    expect(errors(withGate(['check'], {
      ...recordingCheck, verification: { type: 'output_contains', value: 'ok' },
    })).join('\n')).toContain('declares an output_contains gate');
  });

  it('accepts a source that already declares its own json_schema', () => {
    expect(errors(withGate(['check'], {
      ...recordingCheck,
      verification: { type: 'json_schema', schema: { type: 'object' } },
    }))).toEqual([]);
  });
});

describe('steps_green lowering', () => {
  const lowered = (steps: unknown[]) => toKernelSpec(compileSpec(flow(steps) as FlowSpec)).steps;

  it('keeps the host command and puts the assertion in its own fatal step', () => {
    const steps = lowered([
      recordingCheck,
      { id: 'gate', type: 'deterministic', command: 'echo done', verification: { type: 'steps_green', ids: ['check'] } },
    ]);
    const host = steps.find((step) => step.id === 'gate')!;
    expect(host.command).toBe('echo done');
    // The host's own recording policy is its own; the generated gate never
    // inherits it, or a red gate could not fail anything.
    const generated = steps.find((step) => step.id === 'gate.green')!;
    expect(generated).not.toHaveProperty('on_non_zero');
    expect(generated.depends_on).toEqual(expect.arrayContaining(['gate', 'check']));
    expect(generated.input).toEqual({ '0': { step: 'check' } });
    expect(generated.command).toContain('FLOWS_INPUT');
    // Author ids travel as JSON literals, never as shell text.
    expect(generated.command).toContain('["check"]');
  });

  it('gives a bound source the envelope schema its binding needs', () => {
    const steps = lowered([
      recordingCheck,
      { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids: ['check'] } },
    ]);
    expect(steps.find((step) => step.id === 'check')!.verification).toEqual({ json_schema: true });
    // The recording policy survives the rewrite; the source stays red-capable.
    expect(steps.find((step) => step.id === 'check')).toMatchObject({ on_non_zero: 'record' });
  });

  it('preserves a source json_schema exactly rather than widening it', () => {
    const schema = { type: 'object', required: ['exit_code'], properties: { exit_code: { type: 'integer' } } };
    const steps = lowered([
      { ...recordingCheck, verification: { type: 'json_schema', schema } },
      { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids: ['check'] } },
    ]);
    expect(steps.find((step) => step.id === 'check')!.verification).toEqual({ json_schema: schema });
  });

  it('makes dependents of the host wait for the generated gate', () => {
    const steps = lowered([
      recordingCheck,
      { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids: ['check'] } },
      { id: 'ship', type: 'deterministic', dependsOn: ['gate'], command: 'echo ship' },
    ]);
    expect(steps.find((step) => step.id === 'ship')!.depends_on)
      .toEqual(expect.arrayContaining(['gate', 'gate.green']));
  });

  it('picks a generated id that cannot collide with an authored one', () => {
    const steps = lowerStepsGreenGates([
      { id: 'check', type: 'deterministic', command: 'npm test', onNonZero: 'record' },
      { id: 'gate.green', type: 'deterministic', command: 'echo decoy' },
      { id: 'gate', type: 'deterministic', command: 'true', verification: { type: 'steps_green', ids: ['check'] } },
    ] as StepSpec[]);
    expect(steps.map((step) => step.id)).toContain('gate.green.green');
    expect(steps.find((step) => step.id === 'gate.green')!.command).toBe('echo decoy');
  });

  it('leaves a flow without the gate byte-identical', () => {
    const steps: StepSpec[] = [{ id: 'a', type: 'deterministic', command: 'true' }];
    expect(lowerStepsGreenGates(steps)).toEqual(steps);
  });

  it('refuses the gate on a worker host at compile time too', () => {
    expect(() => compileSpec(flow([
      recordingCheck,
      { id: 'gate', type: 'llm', prompt: 'judge', verification: { type: 'steps_green', ids: ['check'] } },
    ]) as FlowSpec)).toThrow(CompileError);
  });
});
