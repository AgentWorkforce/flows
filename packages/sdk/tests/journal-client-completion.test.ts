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

it.each([
  ['a daemon that predates the feature', undefined, false],
  ['a daemon that advertises it', ['reported_cost'], true],
] as const)('sends reported_cost only to %s', async (_name, features, sent) => {
  const path = sockPath();
  const received: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', ...(features === undefined ? {} : { features }) }),
    'step.complete': (ctx, params) => { received.push(params); sendResult(ctx, { status: 'running' }); },
  });
  const client = new JournalClient(path);
  try {
    await client.connect();
    await client.hello('feature-gate');
    await client.stepComplete('run', 'agent', 1, 'key', 'success', {
      usage: { tokens_in: 1, tokens_out: 1, dollars: '0.1' },
      reported_cost: { dollars: '7.169405', source: 'cli' },
    });
    // An older daemon refuses unknown completion fields; the display-only cost
    // is dropped for it rather than failing the step. Metered usage is always sent.
    expect(received[0]!['usage']).toEqual({ tokens_in: 1, tokens_out: 1, dollars: '0.1' });
    if (sent) expect(received[0]!['reported_cost']).toEqual({ dollars: '7.169405', source: 'cli' });
    else expect(received[0]).not.toHaveProperty('reported_cost');
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});
