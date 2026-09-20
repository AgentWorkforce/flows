import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

it('preserves full router receipts, inspect metadata and targeted delivery outcomes on the wire', async () => {
  const path = sockPath();
  const receipt = { generation: 'g1', provider: 'github', scope: { repositoryId: 42 } };
  const snapshots = [{ subscriptionId: 's', state: 'active', routerBinding: receipt,
    ingressOffset: 2, unreadFrames: 1, unreadBytes: 23, settleMs: 50, idleAtMs: 1234, deadlineAtMs: 9000 }];
  const received: unknown[] = [];
  const server = startLoopback(path, {
    'subscription.inspect': (ctx, params) => { received.push(params); sendResult(ctx, { subscriptions: snapshots }); },
    'subscription.deliver': (ctx, params) => {
      received.push(params);
      if (JSON.stringify(params.router_binding) !== JSON.stringify(receipt)) {
        ctx.send({ id: ctx.id, ok: false, error: { code: 'subscription_binding_mismatch', message: 'stale receipt' } });
      } else sendResult(ctx, { appended: false, reason: 'duplicate' });
    },
    'subscription.fence_overflow': (ctx, params) => { received.push(params); sendResult(ctx, { fenced: true }); },
  });
  const client = new JournalClient(path);
  try {
    await client.connect();
    expect(await client.subscriptionInspect({ run_id: 'root' })).toEqual({ subscriptions: snapshots });
    const delivery = { run_id: 'root', subscription_id: 's', router_binding: receipt,
      delivery_id: 'd1', frame: { type: 'github', payload: { id: 1 } } };
    expect(await client.subscriptionDeliver(delivery)).toEqual({ appended: false, reason: 'duplicate' });
    expect(await client.subscriptionFenceOverflow({ run_id: 'root', subscription_id: 's', router_binding: receipt })).toEqual({ fenced: true });
    expect(received).toEqual([{ run_id: 'root' }, delivery,
      { run_id: 'root', subscription_id: 's', router_binding: receipt }]);
    await expect(client.subscriptionDeliver({ ...delivery, router_binding: { generation: 'g1' } }))
      .rejects.toThrow('subscription_binding_mismatch');
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});
