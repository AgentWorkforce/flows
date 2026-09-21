import { describe, expect, it } from 'vitest';
import type { Ctx } from '@relayflows/surface';
import { createHookEvaluator } from '../src/authored-hooks.js';
import type { LoadedFlowExtension } from '../src/flow-extension-loader.js';
import type { JournalClient } from '../src/journal-client.js';

function fakeJournal() {
  const streams = new Map<string, unknown[]>();
  const journal = {
    async streamRead(_run: string, stream: string, offset: number) {
      const messages = (streams.get(stream) ?? []).slice(offset);
      return { messages: messages.map(message => ({ message })), next_offset: (streams.get(stream) ?? []).length };
    },
    async streamAppend(_run: string, stream: string, message: unknown) {
      const list = streams.get(stream) ?? [];
      list.push(message);
      streams.set(stream, list);
      return { offset: list.length };
    },
  } as unknown as JournalClient;
  return { journal, streams };
}

function extension(name: string, impl: (f: Ctx, input: unknown) => Promise<boolean>): LoadedFlowExtension {
  return { name, hooks: { 'merge-gate': impl } } as LoadedFlowExtension;
}

describe('hook AND composition', () => {
  const ctx = {} as Ctx;

  it('is a journaled no-op returning true when nothing implements the hook', async () => {
    const { journal, streams } = fakeJournal();
    const evaluate = createHookEvaluator({
      journal, rootRunId: 'root-1', flowName: 'software-factory',
      declared: ['merge-gate'], extensions: [],
    });
    await expect(evaluate('hook-1', 'merge-gate', {}, ctx)).resolves.toBe(true);
    expect(streams.get('hooks')).toEqual([{ hook: 'merge-gate', step: 'hook-1', plugin: null, verdict: 'noop' }]);
  });

  it('runs implementations in lock order and AND-composes, stopping at the first false', async () => {
    const { journal, streams } = fakeJournal();
    const order: string[] = [];
    const evaluate = createHookEvaluator({
      journal, rootRunId: 'root-1', flowName: 'software-factory',
      declared: ['merge-gate'],
      extensions: [
        extension('first', async () => { order.push('first'); return true; }),
        extension('second', async () => { order.push('second'); return false; }),
        extension('third', async () => { order.push('third'); return true; }),
      ],
    });
    await expect(evaluate('hook-1', 'merge-gate', { owner: 'o' }, ctx)).resolves.toBe(false);
    expect(order).toEqual(['first', 'second']);
    expect(streams.get('hooks')).toEqual([
      { hook: 'merge-gate', step: 'hook-1', plugin: 'first', verdict: 'pass' },
      { hook: 'merge-gate', step: 'hook-1', plugin: 'second', verdict: 'fail' },
    ]);
  });

  it('replays a recorded verdict and does not re-run the closure', async () => {
    const { journal, streams } = fakeJournal();
    streams.set('hooks', [
      { hook: 'merge-gate', step: 'hook-1', plugin: 'first', verdict: 'fail', because: 'held', afterStep: 9 },
    ]);
    let calls = 0;
    let nextStep = 2;
    const evaluate = createHookEvaluator({
      journal, rootRunId: 'root-1', flowName: 'software-factory',
      declared: ['merge-gate'],
      extensions: [extension('first', async () => { calls += 1; return true; })],
      peekStep: () => nextStep,
      restoreStep: (step) => { nextStep = step; },
    });
    await expect(evaluate('hook-1', 'merge-gate', {}, ctx)).resolves.toBe(false);
    expect(calls).toBe(0);
    expect(nextStep).toBe(9);
    expect(streams.get('hooks')).toHaveLength(1);
  });

  it('refuses a hook the base header does not declare', async () => {
    const { journal } = fakeJournal();
    const evaluate = createHookEvaluator({
      journal, rootRunId: 'root-1', flowName: 'software-factory',
      declared: ['merge-gate'], extensions: [],
    });
    await expect(evaluate('hook-1', 'nope', {}, ctx)).rejects.toMatchObject({
      code: 'unsupported_verb',
      message: expect.stringContaining('hook "nope" is not declared'),
    });
  });
});
