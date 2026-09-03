import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type Ctx, type FlowHandle, type Step } from '@relayflows/surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import {
  kernelDialectError,
  sendOk,
  sendResult,
  sockPath,
  startLoopback,
} from './journal-client-loopback.js';

describe('authored flow lifecycle through the journal executor', () => {
  let path: string;
  let server: Server;
  let nextRun = 1;
  const startedSpecs: Record<string, unknown>[] = [];
  const stepByRun = new Map<string, { id: string; command: string }>();

  beforeAll(() => {
    path = sockPath();
    server = startLoopback(path, {
      hello: (ctx) => sendOk(ctx),
      'run.start': (ctx, params) => {
        const error = kernelDialectError(params.spec);
        if (error !== null) {
          ctx.send({ id: ctx.id, ok: false, error: { code: 'invalid_spec', message: error } });
          return;
        }
        const spec = params.spec as Record<string, unknown>;
        const step = (spec['steps'] as Record<string, unknown>[])[0]!;
        const runId = `lifecycle-run-${nextRun++}`;
        const command = step['command'] as string;
        startedSpecs.push(spec);
        stepByRun.set(runId, { id: step['id'] as string, command });
        sendResult(ctx, {
          run_id: runId,
          status: command === 'false' ? 'failed' : 'completed',
          completion_reason: command === 'false' ? 'step_failed' : 'success',
          completed_steps: 1,
        });
      },
      'journal.read': (ctx, params) => {
        const step = stepByRun.get(params.run_id as string)!;
        const failed = step.command === 'false';
        sendResult(ctx, {
          entries: [{
            entry_type: 'step.completed',
            step_id: step.id,
            payload: {
              completionReason: failed ? 'verification_failed' : 'success',
              output: failed ? null : { stdout_tail: '', stderr_tail: '', exit_code: 0 },
            },
          }],
        });
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });

  async function execute(handle: FlowHandle): Promise<Awaited<ReturnType<typeof executeAuthoredFlow>>> {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-lifecycle-test');
    try {
      return await executeAuthoredFlow(handle, client);
    } finally {
      client.close();
    }
  }

  function expectNoTerminalStart(startedBefore: number): void {
    expect(startedSpecs.slice(startedBefore)).not.toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('/complete-') }),
    );
  }

  it('refuses native resolver callbacks without starting terminal success', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('native-resolver-forgery', async (f) => {
      const deferred = Promise.withResolvers<string>();
      f.run('printf native-resolver').then(deferred.resolve, deferred.reject);
      await new Promise((resolve) => setTimeout(resolve, 100));
      f.done('success');
    }))).rejects.toMatchObject({ code: 'unawaited_step' });
    expectNoTerminalStart(startedBefore);
  });

  it.each(['resolve', 'all'] as const)(
    'refuses an ignored Promise.%s operation without terminal success',
    async (combinator) => {
      const startedBefore = startedSpecs.length;
      await expect(execute(flow(`ignored-${combinator}`, async (f) => {
        if (combinator === 'resolve') void Promise.resolve(f.run('printf ignored-resolve'));
        else void Promise.all([f.run('printf ignored-all-1'), f.run('printf ignored-all-2')]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        f.done('success');
      }))).rejects.toMatchObject({ code: 'unawaited_step' });
      expectNoTerminalStart(startedBefore);
    },
  );

  it('retains a swallowed Promise.resolve callback failure before terminal success', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('nested-callback-failure', async (f) => {
      await Promise.resolve(f.run('printf nested-callback'))
        .then(() => { throw new Error('nested callback was handled and forgotten'); })
        .catch(() => undefined)
        .finally(() => undefined);
      f.done('success');
    }))).rejects.toMatchObject({ code: 'operation_callback_failed' });
    expectNoTerminalStart(startedBefore);
  });

  it('retains root failure through a swallowed Promise.resolve callback chain', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('nested-root-failure', async (f) => {
      await Promise.resolve(f.run('false'))
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => undefined);
      f.done('success');
    }))).rejects.toMatchObject({
      code: 'step_failed',
      completionReason: 'verification_failed',
    });
    expectNoTerminalStart(startedBefore);
  });

  it('ignores forged Function.prototype.toString when refusing manual callbacks', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('forged-to-string', async (f) => {
      const originalToString = Function.prototype.toString;
      Function.prototype.toString = () => 'function () { [native code] }';
      try {
        f.run('printf forged-to-string').then(() => undefined, () => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        Function.prototype.toString = originalToString;
      }
      f.done('success');
    }))).rejects.toMatchObject({ code: 'unawaited_step' });
    expectNoTerminalStart(startedBefore);
  });

  // P0 (repair 2026-09-03): the derived-chain gate must not depend on WHEN a
  // derived failure lands. Both bodies below are the same program as
  // 'retains a swallowed Promise.resolve callback failure' with the throw moved
  // past the handful of microtask ticks the gate itself burns.
  it.each([
    ['ten microtask ticks', async (): Promise<void> => {
      for (let tick = 0; tick < 10; tick++) await null;
    }],
    ['setTimeout(0)', (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))],
  ] as const)(
    'refuses a handled-and-forgotten derived failure deferred by %s',
    async (_label, defer) => {
      const startedBefore = startedSpecs.length;
      await expect(execute(flow('deferred-callback-failure', async (f) => {
        const consumed = Promise.resolve(f.run('printf deferred-callback'));
        const derived = consumed.then(async () => {
          await defer();
          throw new Error('derived post-processing failed after the gate sampled');
        });
        derived.catch(() => undefined);
        await consumed;
        f.done('success');
      }))).rejects.toMatchObject({ code: 'unsettled_derived_work' });
      expectNoTerminalStart(startedBefore);
    },
  );

  it('refuses terminal success while derived work is still in flight', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('in-flight-derived-work', async (f) => {
      const consumed = Promise.resolve(f.run('printf in-flight'));
      void consumed.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'late but successful';
      });
      await consumed;
      f.done('success');
    }))).rejects.toMatchObject({ code: 'unsettled_derived_work' });
    expectNoTerminalStart(startedBefore);
  });

  // P1-A (repair 2026-09-03): constructing steps and then awaiting them is
  // ordinary, correct authoring and must not be refused.
  it('preserves pre-constructed steps awaited in a loop', async () => {
    const result = await execute(flow('loop-awaited-steps', async (f) => {
      const steps = [f.run('true'), f.run('true'), f.run('true')];
      for (const step of steps) await step;
      f.done('success');
    }));
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.map((step) => step.id)).toEqual([
      'run-1',
      'run-2',
      'run-3',
      'complete-4',
    ]);
  });

  it('preserves pre-constructed steps awaited out of order', async () => {
    const result = await execute(flow('out-of-order-awaited-steps', async (f) => {
      const first = f.run('true');
      const second = f.run('true');
      await second;
      await first;
      f.done('success');
    }));
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.map((step) => step.id)).toEqual([
      'run-2',
      'run-1',
      'complete-3',
    ]);
  });

  // Repair 2026-09-03: `Promise.all` is the only combinator the lifecycle
  // registers explicitly, so it was the only one whose aggregate was attributed
  // to the operation. allSettled, any and race each carried a deferred derived
  // failure all the way to terminal success. Attribution is now inherited from
  // the context that resolves an aggregate, which covers every combinator
  // without intercepting any of them.
  // Aggregate membership. Every row here has AT LEAST TWO members, at least one
  // of them not an authored step, and names which member resolves the aggregate.
  //
  // The previous revision of these tests used single-member aggregates
  // (`Promise.allSettled([step])`). A single-member aggregate is always resolved
  // by its only member, so those rows could not fail however the mechanism was
  // written: they proved the code path executed, not that the bound held. They
  // passed while `Promise.allSettled([step, slowerUnrelated])` carried a
  // handled-and-forgotten derived failure to terminal success.
  const slowerUnrelated = (): Promise<string> =>
    new Promise((resolve) => setTimeout(() => resolve('unrelated'), 15));
  const fasterUnrelated = (): Promise<string> => Promise.resolve('unrelated-fast');

  const aggregates: Record<string, (step: Step<string>) => Promise<unknown>> = {
    'allSettled resolved by an unrelated member': (step) => Promise.allSettled([step, slowerUnrelated()]),
    'allSettled with the step declared second': (step) => Promise.allSettled([slowerUnrelated(), step]),
    'all resolved by an unrelated member': (step) => Promise.all([step, slowerUnrelated()]),
    'race resolved by an unrelated member': (step) => Promise.race([fasterUnrelated(), step]),
    'any resolved by an unrelated member': (step) => Promise.any([fasterUnrelated(), step]),
    'allSettled resolved by the step itself': (step) => Promise.allSettled([step, fasterUnrelated()]),
    'race resolved by the step itself': (step) => Promise.race([step, slowerUnrelated()]),
  };
  it.each(Object.keys(aggregates))(
    'refuses a deferred derived failure behind an aggregate: %s',
    async (shape) => {
      const startedBefore = startedSpecs.length;
      await expect(execute(flow(`aggregate-${shape}`, async (f) => {
        const step = f.run('printf aggregate');
        const consumed = aggregates[shape]!(step);
        const derived = consumed.then(async () => {
          for (let tick = 0; tick < 10; tick++) await null;
          throw new Error('work derived from the authored step failed');
        });
        derived.catch(() => undefined);
        await consumed;
        // Await the step directly too, so this row cannot pass for the wrong
        // reason: without it, a regression in aggregate REACHABILITY would
        // refuse with `unawaited_step` and mask the derived-failure escape the
        // row exists to catch.
        await step;
        f.done('success');
      }))).rejects.toMatchObject({
        code: expect.stringMatching(/^(unsettled_derived_work|operation_callback_failed)$/),
      });
      expectNoTerminalStart(startedBefore);
    },
  );

  // The same membership rule, opposite sign: a multi-member aggregate over
  // authored steps must be ACCEPTED, whichever member resolves it. Before the
  // membership fix, `await Promise.allSettled([a, b])` refused every step except
  // the last to settle — and `docs/SURFACE.md` documents this as supported.
  const acceptedAggregates: Record<string, (f: Ctx) => Promise<unknown>> = {
    'await Promise.allSettled over two steps': (f) => Promise.allSettled([f.run('true'), f.run('true')]),
    'await Promise.allSettled over five steps': (f) => Promise.allSettled([
      f.run('true'), f.run('true'), f.run('true'), f.run('true'), f.run('true'),
    ]),
    'await Promise.all over three steps': (f) => Promise.all([f.run('true'), f.run('true'), f.run('true')]),
    'await Promise.race over two steps': (f) => Promise.race([f.run('true'), f.run('true')]),
    'await Promise.any over two steps': (f) => Promise.any([f.run('true'), f.run('true')]),
    'await an aggregate mixing a step and an unrelated promise': (f) =>
      Promise.allSettled([f.run('true'), slowerUnrelated()]),
  };
  it.each(Object.keys(acceptedAggregates))('preserves authoring: %s', async (shape) => {
    const result = await execute(flow(`accepted-${shape}`, async (f) => {
      await acceptedAggregates[shape]!(f);
      f.done('success');
    }));
    expect(result.completionReason).toBe('success');
  });

  // A documented limit, pinned so it is a known boundary and not a surprise.
  // V8's async-from-sync iterator resolves its result promise through an
  // internal capability that carries no async_hooks edge back to the awaited
  // value, so the gate cannot prove the step participated in the continuation.
  // It fails CLOSED, which is the safe direction. See docs/SURFACE.md.
  it('refuses for-await over authored steps, and says so in the docs', async () => {
    await expect(execute(flow('for-await-limit', async (f) => {
      for await (const value of [f.run('true')]) void value;
      f.done('success');
    }))).rejects.toMatchObject({ code: 'unawaited_step' });
  });

  // The other side of that widening: work that merely FOLLOWS an authored step,
  // and is awaited, must not be mistaken for unfinished derived work.
  it('preserves ordinary awaited work after an authored step', async () => {
    const result = await execute(flow('work-after-step', async (f) => {
      await f.run('true');
      for (let index = 0; index < 200; index++) await Promise.resolve(index);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await Promise.resolve(1).then((value) => value + 1);
      await f.run('true');
      f.done('success');
    }));
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.map((step) => step.id)).toEqual(['run-1', 'run-2', 'complete-3']);
  });

  it('preserves direct await, Promise.resolve, and Promise.all authoring', async () => {
    const result = await execute(flow('supported-awaits', async (f) => {
      await f.run('true');
      await Promise.resolve(f.run('true'));
      await Promise.all([f.run('true'), f.run('true')]);
      await Promise.all([Promise.resolve(f.run('true')), Promise.resolve(f.run('true'))]);
      f.done('success');
    }));
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.map((step) => step.id)).toEqual([
      'run-1',
      'run-2',
      'run-3',
      'run-4',
      'run-5',
      'run-6',
      'complete-7',
    ]);
  });
});
