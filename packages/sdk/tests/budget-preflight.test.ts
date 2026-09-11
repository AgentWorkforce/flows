import { describe, expect, it, vi } from 'vitest';
import { preflight } from '../src/preflight.js';
import { compileSpec, toKernelSpec, kernelToAuthoring } from '../src/compile.js';
import { flow } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';

const options = () => ({models: ['claude-sonnet-4-6', 'unknown'], probes: {
  cli: vi.fn(() => ({ exists: true, authenticated: true, modelAvailable: true })),
  executor: () => true, command: () => true,
}});
const spec = (budget: unknown, model = 'claude-sonnet-4-6') => ({ version: '0.1.0', budget,
  steps: [{ id: 'ask', type: 'llm', cli: 'claude', model, prompt: 'hello' }] });

describe('budget preflight', () => {
  it('accepts the string header and lowers an exact daily envelope', () => {
    expect(preflight(spec('$20/day'), options()).ok).toBe(true);
    expect(toKernelSpec(compileSpec(spec('$0.10/run'))).budget).toEqual({ pricing: 'frozen', max_dollars: '0.10' });
    expect(toKernelSpec(compileSpec(spec('$20/day'))).budget).toEqual({ pricing: 'frozen', max_dollars: '20', window: 'day' });
  });
  it('accepts object limits and snapshots the surface header', () => {
    const budget = { tokens: 100, dollars: 0.1, wallclock: '2m' };
    const handle = flow('budget', {budget}, async f => { f.done('success'); });
    budget.tokens = 999;
    expect(getFlowDefinition(handle).header.budget).toEqual({ tokens: 100, dollars: 0.1, wallclock: '2m' });
    expect(preflight(spec(budget), options()).ok).toBe(true);
    expect(toKernelSpec(compileSpec(spec(budget))).budget).toEqual({pricing: 'frozen', max_tokens: 999, max_dollars: '0.1', max_wallclock_ms: 120000});
  });
  it('refuses missing windows before any environment probe', () => {
    const o = options();
    const result = preflight(spec('$20'), o);
    expect(result.diagnostics.map(d => d.kind)).toEqual(['budget_syntax_invalid']);
    expect(o.probes.cli).not.toHaveBeenCalled();
  });
  it('refuses an unpriced declared model before probing', () => {
    const o = options();
    const result = preflight(spec('$20/run', 'unknown'), o);
    expect(result.diagnostics.map(d => d.kind)).toEqual(['budget_missing_price']);
    expect(o.probes.cli).not.toHaveBeenCalled();
  });
  it('retains frozen pricing when checking a compiled artifact', () => {
    expect(preflight(kernelToAuthoring(toKernelSpec(compileSpec(spec('$20/run', 'unknown')))), options()).diagnostics)
      .toEqual(expect.arrayContaining([expect.objectContaining({kind: 'budget_missing_price'})]));
  });
  it('requires a model when declaring a dollar budget', () => {
    const input = spec('$20/run');
    const { model, ...step } = input.steps[0]!;
    expect(preflight({...input, steps:[step]}, options()).diagnostics)
      .toEqual(expect.arrayContaining([expect.objectContaining({kind: 'budget_missing_price'})]));
  });
  it.each(['$1/week', '-$1/run', '$1.0000001/run', {tokens: -1}, {wallclock: 'soon'}, {dollars: Infinity}, {typo: 2}])('refuses malformed budget %j', budget => {
    expect(preflight(spec(budget), options()).ok).toBe(false);
  });
});
