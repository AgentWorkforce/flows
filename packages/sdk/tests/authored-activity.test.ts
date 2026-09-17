import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flow, webhook } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { AuthoredFlowExecutionError } from '../src/authored-flow-error.js';
import { decodeWake } from '../src/authored-activity.js';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

describe('authored event activities', () => {
  let path: string;
  let server: Server;
  const calls: Array<{ verb: string; params: Record<string, unknown> }> = [];

  beforeAll(() => {
    path = sockPath();
    server = startLoopback(path, {
      hello: (ctx) => sendOk(ctx),
      'subscription.open': (ctx, params) => {
        calls.push({ verb: 'subscription.open', params });
        sendResult(ctx, { subscription_id: params.subscription_id, stream: 'subscription/activity-1', deadline_at_ms: 99 });
      },
      'subscription.next': (ctx, params) => {
        calls.push({ verb: 'subscription.next', params });
        sendResult(ctx, { kind: 'events', events: [{ type: 'pull_request', payload: { number: 42 } }], offset: 1 });
      },
      'subscription.close': (ctx, params) => {
        calls.push({ verb: 'subscription.close', params });
        sendResult(ctx, { closed: params.subscription_id });
      },
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'completion-run', status: 'completed', completion_reason: 'success', completed_steps: 1,
      }),
      'journal.read': (ctx) => sendResult(ctx, { entries: [{
        entry_type: 'step.completed', step_id: 'complete-1',
        payload: { completionReason: 'success', disposition: 'step_done', output: { exit_code: 0, stdout_tail: '', stderr_tail: '' } },
      }] }),
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });

  it('lowers a bounded activity, decodes events, and closes it with run completion', async () => {
    calls.length = 0;
    const journal = new JournalClient(path, { requestTimeoutMs: 2_000 });
    await journal.connect();
    await journal.hello('authored-activity-test');
    try {
      const result = await executeAuthoredFlow(flow('activity', async (f) => {
        const activity = f.on(webhook('pull_request'), { settle: '2m', idle: '72h', deadline: '14d' });
        await expect.poll(() => calls.map(call => call.verb), { timeout: 2_000 })
          .toEqual(['subscription.open']);
        const wake = await activity.next();
        expect(wake).toEqual({ kind: 'events', events: [{ type: 'pull_request', payload: { number: 42 } }], offset: 1 });
        f.done('success');
      }), journal, undefined, { rootRunId: 'root-activity' });
      expect(result.completionReason).toBe('success');
      expect(calls).toEqual([
        { verb: 'subscription.open', params: {
          run_id: 'root-activity', subscription_id: 'activity-1', event_types: ['pull_request'],
          settle_ms: 120_000, idle_ms: 259_200_000, deadline_ms: 1_209_600_000, include_self: false,
        } },
        { verb: 'subscription.next', params: { run_id: 'root-activity', subscription_id: 'activity-1' } },
        { verb: 'subscription.close', params: { run_id: 'root-activity', subscription_id: 'activity-1', completion_reason: 'run_completed' } },
      ]);
    } finally { journal.close(); }
  });

  it('refuses missing required bounds before journal contact', async () => {
    const journal = new JournalClient('/journal-must-not-be-contacted');
    await expect(executeAuthoredFlow(flow('unbounded', async (f) => {
      f.on(webhook('pull_request'), { idle: '1h' } as never);
      f.done('success');
    }), journal, undefined, { rootRunId: 'root-unbounded' })).rejects.toMatchObject({ code: 'unbounded_subscription' });
  });

  it('does not reopen a cursor after explicit close', async () => {
    calls.length = 0;
    const journal = new JournalClient(path, { requestTimeoutMs: 2_000 });
    await journal.connect();
    await journal.hello('authored-activity-close-test');
    try {
      await executeAuthoredFlow(flow('closed-activity', async (f) => {
        const activity = f.on(webhook('pull_request'), { idle: '1h', deadline: '1d' });
        await activity.close();
        await expect(activity.next()).rejects.toMatchObject({ code: 'activity_closed' });
        f.done('success');
      }), journal, undefined, { rootRunId: 'root-closed-activity' });
      expect(calls.filter(call => call.verb === 'subscription.close')).toEqual([
        { verb: 'subscription.close', params: {
          run_id: 'root-closed-activity', subscription_id: 'activity-1', completion_reason: 'closed',
        } },
      ]);
    } finally { journal.close(); }
  });

  it('cancels an opened cursor when the body fails completion validation', async () => {
    calls.length = 0;
    const journal = new JournalClient(path, { requestTimeoutMs: 2_000 });
    await journal.connect();
    await journal.hello('authored-activity-missing-completion-test');
    try {
      await expect(executeAuthoredFlow(flow('missing-activity-completion', async (f) => {
        f.on(webhook('pull_request'), { idle: '1h', deadline: '1d' });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }), journal, undefined, { rootRunId: 'root-missing-activity-completion' }))
        .rejects.toMatchObject({ code: 'missing_completion' });
      expect(calls.filter(call => call.verb === 'subscription.close')).toEqual([
        { verb: 'subscription.close', params: {
          run_id: 'root-missing-activity-completion', subscription_id: 'activity-1', completion_reason: 'canceled',
        } },
      ]);
    } finally { journal.close(); }
  });

  it.each([
    [{ kind: 'idle' }, { kind: 'idle' }],
    [{ kind: 'deadline', pending: null }, { kind: 'deadline', pending: null }],
    [{ kind: 'deadline', pending: { from: 3, to: 8 } }, { kind: 'deadline', pending: { from: 3, to: 8 } }],
    [{ kind: 'overflow', retained: 4, bytes: 9, from: 5 }, { kind: 'overflow', retained: 4, bytes: 9, from: 5 }],
  ])('decodes Wake %j', (wire, expected) => {
    expect(decodeWake(wire as never)).toEqual(expected);
  });

  it('fails closed on malformed Wake results', () => {
    expect(() => decodeWake({ kind: 'events', events: [{}], offset: 0 } as never))
      .toThrow(AuthoredFlowExecutionError);
  });
});
