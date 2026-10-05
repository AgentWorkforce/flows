import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { waitForRunningStep } from '../src/cli/running-step.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

it('uses pushes for completion with lease-cadence reads and releases its watcher', async () => {
  let reads = 0;
  let watchClosed = false;
  const path = sockPath();
  const server = startLoopback(path, {
    hello: sendOk,
    'run.watch': (ctx, params) => {
      const entry = (run: string, type: string) => ctx.send({ event: 'entry', data: {
        run_id: run, step_id: 'step', entry_type: type,
      } });
      // An older failed attempt in replay must not finish the current one.
      entry('run', 'step.completed');
      entry('run', 'step.attempt.started');
      sendResult(ctx, {});
      entry('other-run', 'step.completed');
      setTimeout(() => entry(String(params['run_id']), 'step.completed'), 2100);
      ctx.socket.once('close', () => { watchClosed = true; });
    },
    'run.get': ctx => { reads++; sendResult(ctx, { steps: { step: {
      state: 'running', lease_deadline_ms: Date.now() + 30_000,
    } } }); },
  });
  await once(server, 'listening');
  const client = new JournalClient(path);
  try {
    await client.connect();
    const start = performance.now();
    await waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, {});
    expect(performance.now() - start).toBeGreaterThan(2000);
    expect(reads).toBeLessThanOrEqual(1);
    await sleep(10);
    expect(watchClosed).toBe(true);
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('cancels a pending watch registration and removes its connection', async () => {
  const path = sockPath();
  let registered!: () => void;
  const registration = new Promise<void>(resolve => { registered = resolve; });
  const server = startLoopback(path, { hello: sendOk, 'run.watch': () => registered() });
  await once(server, 'listening');
  const client = new JournalClient(path);
  const controller = new AbortController();
  try {
    await client.connect();
    const waiting = waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, { signal: controller.signal });
    const rejected = expect(waiting).rejects.toThrow('was canceled');
    await registration;
    controller.abort();
    await rejected;
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
