import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

vi.mock('../src/worker-lease.js', async original => {
  const actual = await original<typeof import('../src/worker-lease.js')>();
  return { ...actual, withWorkerLease: async () => {
    throw new actual.WorkerLeaseLostError('renewal_expired', 'journal client: step.heartbeat timed out after 10ms');
  } };
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('propagates heartbeat lease loss from a helper effect instead of failing the step', async () => {
  const { runHelperEffect } = await import('../src/authored-helper-effect.js');
  const { isLeaseLost } = await import('../src/worker-lease.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'helper-lease-'));
  dirs.push(dataDir);
  vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
  let completions = 0;
  const path = sockPath();
  const server = startLoopback(path, {
    hello: sendOk,
    'run.start': ctx => sendResult(ctx, { run_id: 'helper-run', status: 'running', completion_reason: null, completed_steps: 0 }),
    // The dispatch goes to the attached worker's own connection, after attach.
    'worker.attach': ctx => {
      sendResult(ctx, {});
      setTimeout(() => ctx.send({ event: 'step.dispatch', data: { run_id: 'helper-run', step_id: 'notify', step_type: 'agent',
        attempt: 1, idempotency_key: 'key', lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000, pins: {},
        spec: { type: 'agent' } } }), 20);
    },
    'run.resume': ctx => sendResult(ctx, { run_id: 'helper-run', status: 'running', completion_reason: null, completed_steps: 0 }),
    // Resume reads the journal for a parked helper receipt before the lease can be lost.
    'journal.read': ctx => sendResult(ctx, { entries: [] }),
    'step.complete': ctx => { completions += 1; sendResult(ctx, {}); },
  });
  await once(server, 'listening');
  const journal = new JournalClient(path);
  try {
    await journal.connect();
    const error = await runHelperEffect(journal, 'flow', 'notify',
      { provider: 'slack', verb: 'post', params: { channel: '#c', text: 'hi' } } as never, dataDir, [])
      .catch(caught => caught);
    expect(isLeaseLost(error)).toBe(true);
    expect(completions).toBe(0);
  } finally {
    journal.close();
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
