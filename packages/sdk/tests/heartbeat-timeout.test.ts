import { once } from 'node:events';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { withWorkerLease, WorkerLeaseLostError } from '../src/worker-lease.js';
import { sendOk, sockPath, startLoopback } from './journal-client-loopback.js';

it('a heartbeat timeout is lease loss rather than a worker body failure', async () => {
  const path = sockPath();
  let heartbeats = 0;
  const server = startLoopback(path, { hello: sendOk, 'step.heartbeat': () => { heartbeats++; } });
  await once(server, 'listening');
  const client = new JournalClient(path, { requestTimeoutMs: 10 });
  let executed = false;
  try {
    await client.connect();
    await expect(withWorkerLease(client, {
      run_id: 'run', step_id: 'step', attempt: 1, step_type: 'agent', spec: {},
      lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000, lease_ttl_ms: 30_000,
      idempotency_key: 'key', pins: { workspace: [], streams: [] },
    }, async () => { executed = true; })).rejects.toBeInstanceOf(WorkerLeaseLostError);
    expect(executed).toBe(false);
    expect(heartbeats).toBe(1);
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
