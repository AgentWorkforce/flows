import { describe, expect, it, vi } from 'vitest';
import { readNodeResult, waitForNodeResult, NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';

const correlation = { runId: 'run_1', stepId: 'step_1', dispatchId: 'dispatch_1234567890' };

describe('node-spawn result hardening', () => {
  it('requires immutable attempt correlation and terminal evidence', () => {
    expect(() => readNodeResult({ version: 1, run_id: 'other', step_id: 'step_1',
      dispatch_id: correlation.dispatchId, status: 'completed', output: {} }, correlation)).toThrow('correlation');
    expect(() => readNodeResult({ version: 1, run_id: 'run_1', step_id: 'step_1',
      dispatch_id: correlation.dispatchId, status: 'failed' }, correlation)).toThrow('reason');
    for (const amount of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => readNodeResult({ version: 1, run_id: 'run_1', step_id: 'step_1',
        dispatch_id: correlation.dispatchId, status: 'completed', output: {},
        accounting: { tokens_input: amount } }, correlation)).toThrow('accounting');
    }
  });

  it('ignores a forged name match without the exact immutable sender id', async () => {
    const ack = vi.fn();
    const delivery = await waitForNodeResult({
      inbox: {
        subscribe: async function* () {
          for (const [id, sender] of [['forged', 'attacker'], ['real', 'agent_1']] as const) yield {
            id, message: { id: `message_${id}`, from: { id: sender, name: 'worker' },
              text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_1', step_id: 'step_1',
                dispatch_id: correlation.dispatchId, status: 'completed', output: { id } }) },
          };
        },
        ack: async input => { ack(input); }, fail: async () => {},
      },
    }, { agentId: 'agent_1', agentName: 'worker', ...correlation });
    expect(delivery.envelope.output).toEqual({ id: 'real' });
    expect(ack).not.toHaveBeenCalled();
  });

  it('dead-letters a malformed exact-sender completion only after journal settlement', async () => {
    const fail = vi.fn(async () => ({}));
    const delivery = await waitForNodeResult({ inbox: {
      subscribe: async function* () { yield { id: 'delivery_bad', message: { id: 'message_bad',
        from: { id: 'agent_1', name: 'worker' }, text: NODE_RESULT_PREFIX + '{bad' } }; },
      ack: async () => ({}), fail,
    } }, { agentId: 'agent_1', agentName: 'worker', ...correlation });
    expect(delivery.envelope.status).toBe('failed');
    expect(fail).not.toHaveBeenCalled();
    await delivery.ack();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ inboxItemId: 'delivery_bad', retry: false }));
  });

  it('closes a normal inbox subscription without acknowledging the delivery', async () => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const disconnect = vi.fn(async () => {});
    let delivered = false;
    const ack = vi.fn(async () => ({}));
    const delivery = await waitForNodeResult({ disconnect, inbox: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (delivered) return new Promise<IteratorResult<never>>(() => {});
          delivered = true;
          return { done: false as const, value: { id: 'delivery_1', message: { id: 'message_1',
            from: { id: 'agent_1', name: 'worker' }, text: NODE_RESULT_PREFIX + JSON.stringify({
              version: 1, run_id: 'run_1', step_id: 'step_1', dispatch_id: correlation.dispatchId,
              status: 'completed', output: { ok: true },
            }) } } };
        },
        return: returned,
      }) }),
      ack, fail: async () => ({}),
    } }, { agentId: 'agent_1', agentName: 'worker', ...correlation });
    expect(returned).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    await delivery.ack();
    expect(ack).toHaveBeenCalledOnce();
  });

  it('cancels an initial inbox read even when the client ignores its signal option', async () => {
    const returned = vi.fn();
    const disconnect = vi.fn(async () => {});
    const controller = new AbortController();
    const waiting = waitForNodeResult({ disconnect, inbox: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>(() => {}),
        return: async () => { returned(); return { done: true, value: undefined }; },
      }) }),
      ack: async () => ({}), fail: async () => ({}),
    } }, { agentId: 'agent_1', agentName: 'worker', ...correlation }, controller.signal);
    controller.abort(new Error('lease lost'));
    await expect(waiting).rejects.toThrow('lease lost');
    expect(returned).toHaveBeenCalledOnce();
    await new Promise(resolve => setImmediate(resolve));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('does not wait for an uncooperative iterator close after cancellation', async () => {
    const returned = vi.fn(() => new Promise<IteratorResult<never>>(() => {}));
    const controller = new AbortController();
    const waiting = waitForNodeResult({ inbox: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>(() => {}),
        return: returned,
      }) }),
      ack: async () => ({}), fail: async () => ({}),
    } }, { agentId: 'agent_1', agentName: 'worker', ...correlation }, controller.signal);
    controller.abort(new Error('lease lost'));
    await expect(waiting).rejects.toThrow('lease lost');
    expect(returned).toHaveBeenCalledOnce();
  });

  it('preserves cancellation when a detached iterator close rejects', async () => {
    const returned = vi.fn(async () => { throw new Error('close failed'); });
    const controller = new AbortController();
    const waiting = waitForNodeResult({ inbox: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>(() => {}),
        return: returned,
      }) }),
      ack: async () => ({}), fail: async () => ({}),
    } }, { agentId: 'agent_1', agentName: 'worker', ...correlation }, controller.signal);
    controller.abort(new Error('lease lost'));
    await expect(waiting).rejects.toThrow('lease lost');
    expect(returned).toHaveBeenCalledOnce();
    await new Promise(resolve => setImmediate(resolve));
  });
});
