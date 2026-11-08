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

  it('cancels an initial inbox read even when the client ignores its signal option', async () => {
    const returned = vi.fn();
    const controller = new AbortController();
    const waiting = waitForNodeResult({ inbox: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>(() => {}),
        return: async () => { returned(); return { done: true, value: undefined }; },
      }) }),
      ack: async () => ({}), fail: async () => ({}),
    } }, { agentId: 'agent_1', agentName: 'worker', ...correlation }, controller.signal);
    controller.abort(new Error('lease lost'));
    await expect(waiting).rejects.toThrow('lease lost');
    expect(returned).toHaveBeenCalledOnce();
  });

  it('closes a completed inbox reader without acknowledging the delivery', async () => {
    const returned = vi.fn();
    const ack = vi.fn();
    const delivery = await waitForNodeResult({ inbox: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => {
        let delivered = false;
        return {
          next: async () => {
            if (delivered) return { done: true, value: undefined } as const;
            delivered = true;
            return { done: false, value: { id: 'delivery_1', message: { id: 'message_1',
              from: { id: 'agent_1', name: 'worker' }, text: NODE_RESULT_PREFIX + JSON.stringify({
                version: 1, run_id: 'run_1', step_id: 'step_1', dispatch_id: correlation.dispatchId,
                status: 'completed', output: { ok: true },
              }) } } } as const;
          },
          return: async () => { returned(); return { done: true, value: undefined } as const; },
        };
      } }),
      ack: async input => { ack(input); }, fail: async () => ({}),
    } }, { agentId: 'agent_1', agentName: 'worker', ...correlation });
    expect(returned).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    await delivery.ack();
    expect(ack).toHaveBeenCalledOnce();
  });
});
