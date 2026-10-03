import { readFileSync } from 'node:fs';
import { flow } from '@relayflows/surface';
import { describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { compileSpec, kernelToAuthoring, parseAgentStepTimeout, toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import { validateSpec } from '../src/validate.js';

const spec = (fields = {}) => ({ version: '0.1.0', steps: [{ id: 'a', type: 'agent', instruction: 'repair', ...fields }] });
describe('agent timeout declaration', () => {
  it.each([['45m', 2700000], ['90s', 90000], [2700000, 2700000], ['1.5s', 1500], ['60m', 3600000]])(
    'parses %s and preserves the kernel round trip', (value, ms) => {
      expect(parseAgentStepTimeout(value)).toBe(ms);
      const compiled = compileSpec(spec({ timeoutMs: ms }));
      const kernel = toKernelSpec(compiled);
      expect(kernel.steps[0]).toHaveProperty('timeout_ms', ms);
      expect(kernelToAuthoring(kernel)).toEqual(compiled);
    });
  it.each([0, -1, NaN, Infinity, '5', 'forever', '61m', 3600001])('refuses %s before admission', async timeout => {
    expect(() => parseAgentStepTimeout(timeout)).toThrow();
    await expect(executeAuthoredFlow(flow('invalid', async f => {
      await f.agent('repair', { task: 'repair', timeout });
      f.done('success');
    }), new JournalClient('/never-connect'))).rejects.toMatchObject({ code: 'agent_cli_unresolved' });
  });
  it('keeps omission absent', () => {
    expect(toKernelSpec(compileSpec(spec())).steps[0]).not.toHaveProperty('timeout_ms');
  });
  const cases = JSON.parse(readFileSync(new URL('../../../testdata/agent-timeout-cases.json', import.meta.url), 'utf8'));
  it.each(cases)('$name', ({ timeoutMs, valid }: { timeoutMs: unknown; valid: boolean }) => {
    expect(validateSpec(spec({ timeoutMs })).ok).toBe(valid);
  });
  it.each([{ transport: 'relay' }, { maxIterations: 2 }])('refuses an unenforceable bound: %j', fields => {
    expect(validateSpec(spec({ timeoutMs: 1000, ...fields })).ok).toBe(false);
  });
});
