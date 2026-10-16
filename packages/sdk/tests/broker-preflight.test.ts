import { afterEach, expect, it, vi } from 'vitest';
import { checkAuthoredFlow } from '../src/cli/check.js';
import { budgetDiagnostics } from '../src/budget-preflight.js';
import { compileSpec } from '../src/compile.js';
import { cliProbeKey, type CliProbeOutcome } from '../src/preflight.js';
import { BROKER_TYPE } from '../src/communication/broker-spec.js';
const environment = vi.hoisted(() => vi.fn());
vi.mock('../src/communication/broker-preflight.js', () => ({ checkBrokerEnvironment: environment }));
afterEach(() => vi.resetAllMocks());
function spec() {
  return { version: '0.1.0', budget: '$1/run', steps: [{ id: 'agent', type: 'agent', cli: 'claude',
    model: 'claude-sonnet-4-6', instruction: JSON.stringify({ type: BROKER_TYPE, operation: 'spawn',
      owner: 'root', flow: 'test', step: 'implement', agentName: 'test-agent', task: 'Work', skills: [],
      channel: 'flow-root', keepAlive: false, timeoutMs: 1000 }) }] };
}
it('warns that even a priced broker model cannot be bounded by token or dollar ceilings', () => {
  const warnings = budgetDiagnostics(compileSpec(spec()));
  expect(warnings).toEqual([expect.objectContaining({ kind: 'budget_unmetered', stepId: 'agent',
    message: expect.stringContaining('Token and dollar ceilings cannot bound its spend') })]);
});
it.each([undefined, { tokens: 100 }])('warns about unmetered sessions even without a dollar budget', budget => {
  expect(budgetDiagnostics(compileSpec({ ...spec(), budget }))).toEqual([
    expect.objectContaining({ kind: 'budget_unmetered', stepId: 'agent' }),
  ]);
});
it.each([false, true])('checks broker prerequisites before returning an admissible flow (available=%s)', available => {
  if (!available) environment.mockImplementation(() => { throw new Error('missing local broker'); });
  const cache = new Map<string, CliProbeOutcome>([[cliProbeKey({ stepId: 'agent', cli: 'claude', source: 'step',
    model: 'claude-sonnet-4-6' }, true), { result: { exists: true, authenticated: true, modelAvailable: true, executable: '/usr/bin/true' } }]]);
  const checked = checkAuthoredFlow(spec() as any, '/tmp/test.flow.ts', {
    projectConfig: { directory: '/tmp', models: [], executors: [] }, probeCache: cache,
  });
  expect(environment).toHaveBeenCalledTimes(1);
  expect(checked.report.ok).toBe(available);
  if (!available) {
    expect(checked.flow).toBeUndefined();
    expect(checked.report.diagnostics).toContainEqual(expect.objectContaining({ severity: 'refusal', kind: 'probe_failed', message: 'missing local broker' }));
  }
  expect(checked.report.diagnostics).toContainEqual(expect.objectContaining({ kind: 'budget_unmetered' }));
});
