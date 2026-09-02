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
});
