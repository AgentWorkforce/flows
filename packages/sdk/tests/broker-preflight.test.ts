import { expect, it } from 'vitest';
import { budgetDiagnostics } from '../src/budget-preflight.js';
import { compileSpec } from '../src/compile.js';
import { BROKER_TYPE } from '../src/communication/broker-spec.js';
import { checkBrokerEnvironment } from '../src/communication/broker-preflight.js';

function spec() {
  return { version: '0.1.0', budget: '$1/run', steps: [{ id: 'agent', type: 'agent', cli: 'claude',
    model: 'claude-sonnet-4-6', instruction: JSON.stringify({ type: BROKER_TYPE, operation: 'spawn',
      owner: 'root', flow: 'test', step: 'implement', agentName: 'test-agent', task: 'Work', skills: [],
      channel: 'flow-root', keepAlive: false, timeoutMs: 1000 }) }] };
}

it('keeps legacy broker instructions unmetered while refusing their runtime', () => {
  expect(budgetDiagnostics(compileSpec(spec() as any))).toEqual([
    expect.objectContaining({ kind: 'budget_unmetered', stepId: 'agent' }),
  ]);
  expect(() => checkBrokerEnvironment()).toThrow('transport: broker was removed');
});
