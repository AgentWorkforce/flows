import { describe, expect, it } from 'vitest';
import { CompileError, toKernelSpec } from '../src/compile.js';
import { preflight, type PreflightProbes } from '../src/preflight.js';
import type { FlowSpec } from '../src/spec.js';
import { validateSpec } from '../src/validate.js';

const CHAIN_LENGTH = 10_000;

const probes: PreflightProbes = {
  cli: () => ({ exists: true, authenticated: true }),
  executor: () => true,
  command: () => true,
};

function reverseDependencyChain(length: number): FlowSpec {
  return {
    version: '0.1.0',
    name: `reverse-chain-${length}`,
    steps: Array.from({ length }, (_, index) => ({
      id: `s${index}`,
      type: 'deterministic' as const,
      command: 'true',
      ...(index + 1 < length ? { dependsOn: [`s${index + 1}`] } : {}),
    })),
  };
}

function reverseDependencyCycle(length: number): FlowSpec {
  const flow = reverseDependencyChain(length);
  const last = flow.steps[length - 1];
  if (last === undefined) throw new Error('cycle fixture requires at least one step');
  last.dependsOn = ['s0'];
  return flow;
}

function denseBackEdgeGraph(length: number): FlowSpec {
  return {
    version: '0.1.0',
    name: `dense-back-edges-${length}`,
    steps: Array.from({ length }, (_, index) => ({
      id: `s${index}`,
      type: 'deterministic' as const,
      command: 'true',
      dependsOn: [
        ...(index + 1 < length ? [`s${index + 1}`] : []),
        ...Array.from({ length: index }, (__, dependency) => `s${dependency}`),
      ],
    })),
  };
}

describe('dependency validation', () => {
  it('accepts a valid 10,000-step reverse chain through every direct public boundary', () => {
    const flow = reverseDependencyChain(CHAIN_LENGTH);

    expect(validateSpec(flow)).toEqual({ ok: true, errors: [] });
    const result = preflight(flow, { probes });
    expect(result.ok).toBe(true);
    expect(result.resolutions).toEqual([]);
    expect(result.diagnostics).toHaveLength(CHAIN_LENGTH);
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(toKernelSpec(flow).steps).toHaveLength(CHAIN_LENGTH);
  });

  it('still rejects a dependency cycle fail-closed through every direct public boundary', () => {
    const flow: FlowSpec = {
      version: '0.1.0',
      name: 'cycle',
      steps: [
        { id: 'a', type: 'deterministic', command: 'true', dependsOn: ['b'] },
        { id: 'b', type: 'deterministic', command: 'true', dependsOn: ['c'] },
        { id: 'c', type: 'deterministic', command: 'true', dependsOn: ['a'] },
      ],
    };
    const expected = 'spec.steps: dependency cycle detected at "a" (path: a -> b -> c -> a)';

    expect(validateSpec(flow)).toEqual({ ok: false, errors: [expected] });
    expect(preflight(flow, { probes })).toEqual({
      ok: false,
      resolutions: [],
      diagnostics: [{
        severity: 'refusal',
        kind: 'invalid_spec',
        message: expect.stringContaining(expected),
        errors: [expected],
      }],
    });
    expect(() => toKernelSpec(flow)).toThrow(CompileError);
    expect(() => toKernelSpec(flow)).toThrow(expected);
  });

  it.each([50, 100, 150])(
    'reports only the first deterministic cycle for %i nodes with dense active-path back edges',
    (length) => {
      const flow = denseBackEdgeGraph(length);
      const result = validateSpec(flow);

      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('dependency cycle detected at "s0"');

      const preflightResult = preflight(flow, { probes });
      expect(preflightResult.ok).toBe(false);
      expect(preflightResult.diagnostics).toHaveLength(1);
      expect(preflightResult.diagnostics[0]?.errors).toHaveLength(1);
      expect(() => toKernelSpec(flow)).toThrow(CompileError);
    },
  );

  it('bounds the author-facing path for a 10,000-step cycle', () => {
    const flow = reverseDependencyCycle(CHAIN_LENGTH);
    const expected = 'spec.steps: dependency cycle detected at "s0" (path: '
      + 's0 -> s1 -> s2 -> s3 -> s4 -> s5 -> s6 -> s7 -> '
      + '... (9985 steps omitted) ... -> '
      + 's9993 -> s9994 -> s9995 -> s9996 -> s9997 -> s9998 -> s9999 -> s0)';
    const result = validateSpec(flow);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expected]);
    expect(result.errors[0]?.length).toBeLessThan(1_024);

    const preflightResult = preflight(flow, { probes });
    expect(preflightResult.ok).toBe(false);
    expect(preflightResult.diagnostics[0]?.errors).toEqual([expected]);
    expect(() => toKernelSpec(flow)).toThrow(expected);
  });
});
