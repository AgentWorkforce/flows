import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kernelToAuthoring, compileSpec } from '../src/compile.js';

const cases = JSON.parse(readFileSync(new URL('../../../testdata/memory-spec-cases.json', import.meta.url), 'utf8')) as { name: string; valid: boolean; memory: unknown }[];

describe('step memory declaration parity', () => {
  for (const row of cases) {
    it(row.name, () => {
      const parse = () => compileSpec(kernelToAuthoring({ version: '0.1.0', name: 'memory', steps: [{ id: 's', type: 'deterministic', command: 'true', memory: row.memory }] }));
      if (row.valid) expect(parse().steps[0]?.memory).toBeDefined();
      else expect(parse).toThrow();
    });
  }
  it('rejects authoring typos rather than omitting memory from compilation', () => {
    expect(() => compileSpec({ version: '0.1.0', name: 'memory', steps: [{ id: 's', type: 'deterministic', command: 'true', memory: { scope: 'script', query: 'lessons', budget: { max_tokens_in: 7 } } }] })).toThrow();
  });
});
