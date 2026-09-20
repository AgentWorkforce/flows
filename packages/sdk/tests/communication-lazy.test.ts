import { EventEmitter } from 'node:events';
import { it, expect, vi } from 'vitest';
import { AgentWorker } from '../src/worker.js';
import type { JournalClient } from '../src/journal-client.js';
vi.mock('../src/worker-cli.js', () => ({ runAgentCli: vi.fn(async () => ({ exit_code: 0, stdout_tail: 'done', stderr_tail: '' })) }));
vi.mock('../src/communication/worker.js', () => { throw new Error('Ordinary steps must not import communication machinery'); });
it('completes an ordinary agent without importing the managed communication worker', async () => {
  const client = Object.assign(new EventEmitter(), {
    workerAttach: vi.fn(async () => ({})),
    stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
    stepComplete: vi.fn(async () => ({})),
  });
  const worker = new AgentWorker(client as unknown as JournalClient, { workerId: 'plain', pins: {} });
  const errors: unknown[] = [];
  worker.on('error', error => errors.push(error));
  await worker.attach();
  client.emit('step.dispatch', { run_id: 'plain', step_id: 'agent', step_type: 'agent', attempt: 1,
    lease_deadline_ms: Date.now() + 30_000, lease_id: 'lease', idempotency_key: 'id', pins: {},
    spec: { type: 'agent', cli: 'claude', instruction: 'ordinary DAG step' } });
  await worker.close();
  expect(errors).toEqual([]);
  expect(client.stepComplete).toHaveBeenCalledWith('plain', 'agent', 1, 'id', 'success', expect.anything());
});
