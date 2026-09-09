import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

it('waits for step.complete to drive downstream work beyond the request timeout', async () => {
  const path = sockPath();
  const server = startLoopback(path, {
    'step.complete': ctx => {
      setTimeout(() => sendResult(ctx, { status: 'completed' }), 80);
    },
    hello: () => { /* Bounded requests still time out. */ },
  });
  const client = new JournalClient(path, { requestTimeoutMs: 10 });
  try {
    await client.connect();
    await expect(client.stepComplete('run', 'agent', 1, 'key', 'success'))
      .resolves.toEqual({ status: 'completed' });
    await expect(client.hello('timeout-proof')).rejects.toThrow('hello timed out after 10ms');
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});

it.each(['rejection', 'disconnect', 'caller close'] as const)(
  'still rejects an unbounded step.complete on %s', async failure => {
    const path = sockPath();
    let received!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    const server = startLoopback(path, {
      'step.complete': ctx => {
        received();
        if (failure === 'disconnect') ctx.socket.destroy();
        if (failure === 'rejection') ctx.send({
          id: ctx.id, ok: false,
          error: { code: 'journal_write_failed', message: 'disk full' },
        });
      },
    });
    const client = new JournalClient(path, { requestTimeoutMs: 10 });
    try {
      await client.connect();
      const expected = failure === 'rejection' ? 'journal_write_failed: disk full'
        : failure === 'disconnect' ? 'connection closed' : 'closed by caller';
      const rejected = expect(client.stepComplete('run', 'agent', 1, 'key', 'success'))
        .rejects.toThrow(expected);
      await requestReceived;
      if (failure === 'caller close') client.close();
      await rejected;
    } finally {
      client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(path, { force: true });
    }
  },
);
