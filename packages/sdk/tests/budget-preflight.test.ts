import { describe, expect, it, vi } from 'vitest';
import { preflight } from '../src/preflight.js';
import { compileSpec, CompileError, toKernelSpec, kernelToAuthoring } from '../src/compile.js';
import { flow } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import { budgetDiagnostics } from '../src/budget-preflight.js';

const options = () => ({models: ['claude-opus-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'unknown'], probes: {
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
  it('warns, never refuses, on an unpriced declared model and still probes', () => {
    const o = options();
    const result = preflight(spec('$20/run', 'unknown'), o);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'warning', kind: 'budget_unmetered', stepId: 'ask',
      message: expect.stringContaining('model "unknown" has no frozen price'),
    })]);
    expect(o.probes.cli).toHaveBeenCalledWith('claude', 'step', 'unknown');
  });
  it('retains frozen pricing when checking a compiled artifact', () => {
    const result = preflight(kernelToAuthoring(toKernelSpec(compileSpec(spec('$20/run', 'unknown')))), options());
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({severity: 'warning', kind: 'budget_unmetered'}),
    ]));
  });
  it('emits no budget warning for priced steps or for token-only budgets', () => {
    expect(preflight(spec('$20/run'), options()).diagnostics).toEqual([]);
    expect(preflight(spec({ tokens: 100 }, 'unknown'), options()).diagnostics).toEqual([]);
  });
  it('lets a Codex step without a model run unmetered beside a priced Claude step (burn#539)', () => {
    const o = options();
    const result = preflight({ version: '0.1.0', budget: '$8/run', steps: [
      { id: 'planner', type: 'agent', cli: 'claude', instruction: 'Plan.' },
      { id: 'plan-reviewer', type: 'agent', cli: 'codex', instruction: 'Review.', dependsOn: ['planner'] },
    ] }, o);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter(d => d.severity === 'refusal')).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'warning', kind: 'budget_unmetered', stepId: 'plan-reviewer',
      message: expect.stringContaining('Codex selects its own model'),
    })]);
    expect(o.probes.cli).toHaveBeenCalledWith('claude', 'step', 'claude-opus-5');
    expect(o.probes.cli).toHaveBeenCalledWith('codex', 'step', undefined);
  });
  it('prices and probes the Claude default when a dollar-budgeted step omits model', () => {
    const input = spec('$20/run');
    const { model, ...step } = input.steps[0]!;
    const o = options();
    const result = preflight({...input, steps:[step]}, o);
    expect(result.ok).toBe(true);
    expect(result.resolutions).toContainEqual(expect.objectContaining({
      stepId: 'ask', cli: 'claude', model: 'claude-opus-5', modelSource: 'adapter',
    }));
    expect(o.probes.cli).toHaveBeenCalledWith('claude', 'step', 'claude-opus-5');
  });
  it.each([
    ['codex', 'Codex selects its own model'],
    ['team-wrapper', 'no model is declared'],
  ])('runs registered/custom CLI %s with no default model unmetered under a dollar budget', (cli, reason) => {
    const input = spec('$20/run');
    const { model, ...step } = input.steps[0]!;
    const result = preflight({...input, steps:[{...step, cli}]}, options());
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'warning', kind: 'budget_unmetered', stepId: 'ask', message: expect.stringContaining(reason),
    })]);
  });
  it('does not require Codex model ids to be priced', () => {
    const input = compileSpec(spec('$20/run'));
    const { model, ...step } = input.steps[0]!;
    expect(budgetDiagnostics({...input, steps:[{...step, cli: 'codex'}]}, new Map([
      ['ask', { cli: 'codex', model: 'gpt-5.2-codex' }],
    ]))).toEqual([expect.objectContaining({ severity: 'warning', kind: 'budget_unmetered', stepId: 'ask' })]);
  });
  it('warns on an unpriced adapter default under a frozen dollar budget', () => {
    const input = compileSpec(spec('$20/run'));
    const { model, ...step } = input.steps[0]!;
    expect(budgetDiagnostics({...input, steps:[step]}, new Map([
      ['ask', { cli: 'claude', model: 'future-default' }],
    ]))).toEqual([expect.objectContaining({
      severity: 'warning', kind: 'budget_unmetered', stepId: 'ask',
      message: expect.stringContaining('"future-default"'),
    })]);
  });
  it('resolves and probes the adapter default without requiring price for a token-only budget', () => {
    const input = spec({ tokens: 100 });
    const { model, ...step } = input.steps[0]!;
    const o = options();
    const result = preflight({...input, steps:[step]}, o);
    expect(result.ok).toBe(true);
    expect(result.resolutions).toContainEqual(expect.objectContaining({
      stepId: 'ask', model: 'claude-opus-5', modelSource: 'adapter',
    }));
    expect(o.probes.cli).toHaveBeenCalledWith('claude', 'step', 'claude-opus-5');
  });
  it('uses a selected named-agent model ahead of the Claude adapter default', () => {
    const o = options();
    const result = preflight({
      version: '0.1.0',
      budget: '$20/run',
      agents: { reviewer: { cli: 'claude', model: 'claude-opus-4-7' } },
      steps: [{ id: 'ask', type: 'agent', agent: 'reviewer', instruction: 'Review.' }],
    }, o);
    expect(result.ok).toBe(true);
    expect(result.resolutions).toEqual([expect.objectContaining({
      stepId: 'ask', cli: 'claude', model: 'claude-opus-4-7', modelSource: 'named',
    })]);
    expect(o.probes.cli).toHaveBeenCalledWith('claude', 'named', 'claude-opus-4-7');
  });
  it('enforces the model allowlist on an implicit Claude default before probing', () => {
    const input = spec('$20/run');
    const { model, ...step } = input.steps[0]!;
    const o = options();
    const result = preflight({...input, steps:[step]}, {
      ...o, models: ['claude-sonnet-4-6'], modelRegistryPath: '/project/flows.json',
    });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      kind: 'model_unknown', stepId: 'ask', model: 'claude-opus-5',
    })]);
    expect(o.probes.cli).not.toHaveBeenCalled();
  });
  it.each(['$1/week', '-$1/run', '$1.0000001/run', {tokens: -1}, {wallclock: 'soon'}, {dollars: Infinity}, {typo: 2}])('refuses malformed budget %j', budget => {
    expect(preflight(spec(budget), options()).ok).toBe(false);
  });
  it.each(['$$$', '$1/week', {typo: 2}])('compileSpec wraps parseBudget throws as a CompileError with a budget-scoped message (%j)', budget => {
    let caught: unknown;
    try { compileSpec(spec(budget)); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CompileError);
    expect((caught as CompileError).errors[0]).toMatch(/^spec\.budget: /);
    expect((caught as CompileError).errors[0]).toContain('budget_syntax_invalid');
  });
});
