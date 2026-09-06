import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type FlowHandle, type Step } from '@relayflows/surface';
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
  //
  // 2026-09-06: these rows were SINGLE-member aggregates, which cannot fail by
  // construction. With one member there is only one context that can resolve
  // the aggregate — that member's — so attribution is inherited correctly no
  // matter what the implementation does, and every row passed vacuously.
  //
  // The escape being tested needs the aggregate to be resolved by an ORDINARY
  // promise rather than by the authored step. Each row below is therefore
  // multi-member and arranged so the ordinary member is the resolver:
  //
  //   - allSettled/all resolve on the LAST settlement, so the ordinary member
  //     must settle last;
  //   - any/race resolve on the EARLIEST, so it must settle first.
  //
  // The ordering is structural, not timed. Both members are already settled
  // before the aggregate is built (the step is awaited first, and `ordinary` is
  // pre-resolved), so the combinator's own subscription order decides which
  // reaction resolves the aggregate — first-listed reacts first. A timer would
  // have made the ordering a race against a real subprocess.
  type CombinatorCase = {
    build: (step: Step<string>, ordinary: Promise<unknown>) => Promise<unknown>;
    // Whether the step is awaited BEFORE the aggregate is built. With a
    // pre-resolved `ordinary`, awaiting first makes ordinary the LAST member to
    // settle; leaving the step pending makes it the FIRST.
    settleStepFirst: boolean;
  };
  const combinators: Record<string, CombinatorCase> = {
    // Resolve on the LAST settlement: pre-settle the step so ordinary is last.
    allSettled: { build: (s, o) => Promise.allSettled([s, o]), settleStepFirst: true },
    all: { build: (s, o) => Promise.all([s, o]), settleStepFirst: true },
    // Resolve on the EARLIEST: leave the step pending so ordinary wins.
    any: { build: (s, o) => Promise.any([o, s]), settleStepFirst: false },
    race: { build: (s, o) => Promise.race([o, s]), settleStepFirst: false },
    // Not an aggregate; the control that a plain passthrough still holds.
    resolve: { build: (s) => Promise.resolve(s), settleStepFirst: false },
  };
  it.each(Object.keys(combinators))(
    'refuses a deferred derived failure consumed through Promise.%s',
    async (combinator) => {
      const testCase = combinators[combinator]!;
      const startedBefore = startedSpecs.length;
      await expect(execute(flow(`combinator-${combinator}`, async (f) => {
        const step = f.run('printf combinator');
        if (testCase.settleStepFirst) await step;
        const consumed = testCase.build(step, Promise.resolve('ordinary'));
        const derived = consumed.then(async () => {
          for (let tick = 0; tick < 10; tick++) await null;
          throw new Error('derived post-processing failed after the gate sampled');
        });
        derived.catch(() => undefined);
        await consumed;
        // Consume the step in every row. Where ordinary resolves the aggregate
        // the step's own branch is discarded, and an unconsumed step would be
        // refused as `unawaited_step` before the derived-work gate is reached —
        // which would pass the row for the wrong reason.
        await step;
        f.done('success');
      }))).rejects.toMatchObject({ code: 'unsettled_derived_work' });
      expectNoTerminalStart(startedBefore);
    },
  );

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
