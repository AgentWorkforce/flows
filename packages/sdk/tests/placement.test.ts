import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { compileSpec, kernelToAuthoring, toKernelSpec } from '../src/compile.js';

const cases = JSON.parse(readFileSync(new URL('../../../testdata/placement-spec-cases.json', import.meta.url), 'utf8'));

describe('placement declarations', () => {
  for (const test of cases) {
    for (const type of ['deterministic', 'llm', 'agent']) {
      it(`${test.name}: ${type}`, () => {
        const requirements = test.requirements && !Array.isArray(test.requirements)
          ? Object.fromEntries(Object.entries(test.requirements).map(([key, value]) => [key === 'expected_duration_ms' ? 'expectedDurationMs' : key, value]))
          : test.requirements;
        const field = type === 'deterministic' ? 'command' : type === 'llm' ? 'prompt' : 'instruction';
        const flow = { version: '0.1.0', steps: [{ id: 's', type, [field]: 'true', requirements }] };
        if (test.valid) {
          const compiled = compileSpec(flow);
          const kernel = toKernelSpec(compiled);
          expect(kernel.steps[0]?.requirements).toEqual(test.requirements);
          expect(kernelToAuthoring(kernel)).toEqual(compiled);
        } else {
          expect(() => compileSpec(flow)).toThrow();
        }
      });
    }
  }
});
