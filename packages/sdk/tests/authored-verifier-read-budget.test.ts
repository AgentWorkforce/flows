import { expect, it, vi } from 'vitest';
import { FLOW_READ_BUDGET_MS } from '../src/journal-read-policy.js';

const constructed = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/journal-client.js', async original => {
  const actual = await original<typeof import('../src/journal-client.js')>();
  class RecordingClient extends actual.JournalClient {
    constructor(socketPath: string, options?: ConstructorParameters<typeof actual.JournalClient>[1]) {
      super(socketPath, options);
      constructed.push(options);
    }
    override async connect(): Promise<void> { throw new Error('stop after construction'); }
  }
  return { ...actual, JournalClient: RecordingClient };
});

it('verifies a Bun-run authored result with the flow read budget, not single-shot reads', async () => {
  const { verifyAuthoredNodeResult } = await import('../src/authored-node-runner.js');
  const result = { rootRunId: 'root', name: 'flow', completionReason: 'success',
    journalSteps: [{ id: 'complete-1' }] };
  await verifyAuthoredNodeResult(result as never, { flowName: 'flow' } as never, 'root', '/unused.sock').catch(() => undefined);
  expect(constructed).toContainEqual(expect.objectContaining({ readBudgetMs: FLOW_READ_BUDGET_MS }));
});

it('hands the lifecycle signal to the verifier so cancellation stops its reads', async () => {
  const { verifyAuthoredNodeResult } = await import('../src/authored-node-runner.js');
  constructed.length = 0;
  const controller = new AbortController();
  const result = { rootRunId: 'root', name: 'flow', completionReason: 'success', journalSteps: [{ id: 'complete-1' }] };
  await verifyAuthoredNodeResult(result as never, { flowName: 'flow' } as never, 'root', '/unused.sock', controller.signal)
    .catch(() => undefined);
  expect(constructed).toContainEqual(expect.objectContaining({ readSignal: controller.signal }));
});
