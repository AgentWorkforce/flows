import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type Ctx, type FlowHandle, type Step } from '@relayflows/surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuthoredFlow, type ExecuteAuthoredFlowOptions } from '../src/authored-flow-executor.js';
import { AuthoredFlowLifecycle, parallelPromiseIntrinsicsIntact } from '../src/authored-flow-lifecycle.js';
import { JournalClient } from '../src/journal-client.js';
import {
  kernelDialectError,
  sendOk,
  sendResult,
  sockPath,
  startLoopback,
} from './journal-client-loopback.js';

const unobservedAll = Promise.all.bind(Promise);
const handmadeAll = <T>(values: readonly PromiseLike<T>[]): Promise<T[]> =>
  new Promise((resolve, reject) => {
    const result: T[] = new Array(values.length);
    let remaining = values.length;
    if (remaining === 0) resolve(result);
    values.forEach((value, index) => Promise.resolve(value).then(item => {
      result[index] = item;
      if (--remaining === 0) resolve(result);
    }, reject));
  });

describe('authored flow lifecycle through the journal executor', () => {
  it('detects replacement of every Promise primitive used by parallel joins', () => {
    expect(parallelPromiseIntrinsicsIntact()).toBe(true);
    const nativePromise = globalThis.Promise;
    try {
      globalThis.Promise = function ReplacedPromise() {} as unknown as PromiseConstructor;
      expect(parallelPromiseIntrinsicsIntact(), 'constructor').toBe(false);
    } finally { globalThis.Promise = nativePromise; }
    for (const name of ['resolve', 'reject', 'all', 'allSettled', 'race', 'any']) {
      const target = Promise as unknown as Record<string, unknown>;
      const original = target[name];
      target[name] = () => undefined;
      const detected = parallelPromiseIntrinsicsIntact();
      target[name] = original;
      expect(detected, name).toBe(false);
    }
    for (const name of ['then', 'catch', 'finally']) {
      const target = Promise.prototype as unknown as Record<string, unknown>;
      const original = target[name];
      target[name] = () => undefined;
      const detected = parallelPromiseIntrinsicsIntact();
      target[name] = original;
      expect(detected, name).toBe(false);
    }
    const constructor = Promise.prototype.constructor;
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor')!;
    try {
      Promise.prototype.constructor = class OtherPromise {} as unknown as PromiseConstructor;
      expect(parallelPromiseIntrinsicsIntact(), 'prototype constructor').toBe(false);
    } finally { Promise.prototype.constructor = constructor; }
    try {
      Object.defineProperty(Promise.prototype, 'constructor', {
        ...constructorDescriptor, enumerable: !constructorDescriptor.enumerable,
      });
      expect(parallelPromiseIntrinsicsIntact(), 'prototype constructor descriptor').toBe(false);
    } finally { Object.defineProperty(Promise.prototype, 'constructor', constructorDescriptor); }
    const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
    try {
      Object.defineProperty(Promise, Symbol.species, { configurable: true, get: () => Promise });
      expect(parallelPromiseIntrinsicsIntact(), 'species getter').toBe(false);
    } finally { Object.defineProperty(Promise, Symbol.species, species); }
    try {
      Object.defineProperty(Promise, Symbol.species, { ...species, enumerable: !species.enumerable });
      expect(parallelPromiseIntrinsicsIntact(), 'species descriptor').toBe(false);
    } finally { Object.defineProperty(Promise, Symbol.species, species); }
    const toString = Function.prototype.toString;
    try {
      Function.prototype.toString = function () { return toString.call(this); };
      expect(parallelPromiseIntrinsicsIntact(), 'function toString').toBe(false);
    } finally { Function.prototype.toString = toString; }
    const nodeOptions = process.env['NODE_OPTIONS'];
    try {
      process.env['NODE_OPTIONS'] = '--import=/tmp/preload.mjs';
      expect(parallelPromiseIntrinsicsIntact(), 'NODE_OPTIONS preload').toBe(false);
    } finally {
      if (nodeOptions === undefined) delete process.env['NODE_OPTIONS'];
      else process.env['NODE_OPTIONS'] = nodeOptions;
    }
    process.execArgv.push('--require', '/tmp/preload.cjs');
    try { expect(parallelPromiseIntrinsicsIntact(), 'execArgv preload').toBe(false); }
    finally { process.execArgv.splice(-2); }
    expect(parallelPromiseIntrinsicsIntact()).toBe(true);
  });

  it('refuses untracked thenables before invoking their user-supplied then', () => {
    const violations: string[] = [];
    const lifecycle = new AuthoredFlowLifecycle(message => violations.push(message));
    let thenReads = 0;
    const hiddenThenable = new Proxy({}, { get: (_target, name) => {
      if (name === 'then') { thenReads++; return (resolve: (value: string) => void) => resolve('A'); }
      return undefined;
    } });
    try {
      expect(() => lifecycle.runBody(() => Promise.all([
        hiddenThenable,
        Promise.resolve('B'),
      ]))).toThrow(/member with no tracked provenance/u);
      expect(violations).toContain('parallel Promise.all contains a member with no tracked provenance');
      expect(thenReads).toBe(0);
    } finally { lifecycle.close(); }
  });
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
        const complete = () => sendResult(ctx, {
          run_id: runId,
          status: command === 'false' ? 'failed' : 'completed',
          completion_reason: command === 'false' ? 'step_failed' : 'success',
          completed_steps: 1,
        });
        if (command.startsWith('hold-')) setTimeout(complete, 300);
        else complete();
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

  async function execute(handle: FlowHandle, options: ExecuteAuthoredFlowOptions = {})
    : Promise<Awaited<ReturnType<typeof executeAuthoredFlow>>> {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-lifecycle-test');
    try {
      return await executeAuthoredFlow(handle, client, undefined, options);
    } finally {
      client.close();
    }
  }

  function expectNoTerminalStart(startedBefore: number): void {
    expect(startedSpecs.slice(startedBefore)).not.toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('/complete-') }),
    );
  }

  it('keeps a caught parallel non-run refusal as a root failure', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-hidden-llm', async f => {
      try { f.llm('prompt', { output: { type: 'string' } }); } catch { /* author swallowed refusal */ }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toMatchObject({ code: 'step_failed' });
    expect(startedSpecs).toHaveLength(startedBefore);
  });

  it('refuses later admissions after a caught parallel violation', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-refusal-stays-closed', async f => {
      try { f.llm('prompt', { output: { type: 'string' } }); } catch { /* author swallowed refusal */ }
      try { await f.run('printf E'); } catch { /* this admission must also be refused */ }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toMatchObject({ code: 'step_failed' });
    expect(startedSpecs).toHaveLength(startedBefore);
  });

  it('refuses generated fanout before admitting a child', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-queued-violation', async f => {
      const children = Array.from({ length: 9 }, (_, index) => f.run(`hold-${index}`));
      const joined = Promise.allSettled(children);
      setTimeout(() => {
        try { f.llm('unsupported', { output: { type: 'string' } }); }
        catch { /* the root failure still owns this scope */ }
      }, 30);
      await joined;
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toMatchObject({ code: 'step_failed' });
    expect(startedSpecs).toHaveLength(startedBefore);
  });

  it('refuses a parallel follow-up through an unobserved Promise.all', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-unobserved-aggregate', async f => {
      await unobservedAll([f.run('printf A'), f.run('printf B')]);
      await f.run('printf X');
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    const admitted = startedSpecs.slice(startedBefore).map(spec => spec['name']);
    expect(admitted).toEqual([]);
  });

  it('refuses an unobserved join after an earlier step', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-late-unobserved-aggregate', async f => {
      await f.run('printf W');
      await unobservedAll([f.run('printf A'), f.run('printf B'), f.run('printf C')]);
      await f.run('printf X');
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    expect(startedSpecs.slice(startedBefore).map(spec => spec['name']))
      .toEqual([]);
  });

  it('refuses a hand-written join after an earlier step', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-late-handmade-aggregate', async f => {
      await f.run('printf W');
      await handmadeAll([f.run('printf A'), f.run('printf B')]);
      await f.run('printf X');
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    expect(startedSpecs.slice(startedBefore)).toHaveLength(0);
  });

  it('refuses a sequential-only body forced into parallel mode', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-sequential', async f => {
      await f.run('printf A');
      await f.run('printf B');
      await f.run('printf C');
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    expect(startedSpecs).toHaveLength(startedBefore);
  });

  it('admits branch dependents after a shared predecessor', async () => {
    await expect(execute(flow('parallel-shared-branch-predecessor', async f => {
      await f.run('printf W');
      const a = async () => { await f.run('printf A'); await f.run('printf A2'); };
      const b = async () => { await f.run('printf B'); await f.run('printf B2'); };
      await Promise.all([a(), b()]);
      await f.run('printf X');
      f.done('success');
    }), { executionMode: 'parallel' })).resolves.toMatchObject({ completionReason: 'success' });
  });

  it('refuses a body that writes Promise.all before its first child', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-replaced-observer', async f => {
      await f.run('printf W');
      const observed = Promise.all;
      Promise.all = unobservedAll as typeof Promise.all;
      try {
        await Promise.all([f.run('printf A'), f.run('printf B')]);
        await f.run('printf X');
      } finally { Promise.all = observed; }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    expect(startedSpecs.slice(startedBefore).map(spec => spec['name']))
      .toEqual([]);
  });

  it('refuses a body that writes Promise.allSettled before its first child', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-replaced-all-settled', async f => {
      await f.run('printf W');
      const observed = Promise.allSettled;
      Promise.allSettled = ((values: Iterable<unknown>) => observed.call(Promise, values)) as typeof Promise.allSettled;
      try { await f.run('printf X'); }
      finally { Promise.allSettled = observed; }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    expect(startedSpecs.slice(startedBefore).map(spec => spec['name']))
      .toEqual([]);
  });

  it('refuses a body that writes Promise.race before its first child', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-unrelated-race-patch', async f => {
      await f.run('printf W');
      const observed = Promise.race;
      Promise.race = ((values: Iterable<unknown>) => observed.call(Promise, Array.from(values))) as typeof Promise.race;
      try {
        await Promise.all([f.run('printf A'), f.run('printf B')]);
        await f.run('printf X');
      } finally { Promise.race = observed; }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    expect(startedSpecs.slice(startedBefore).map(spec => spec['name']))
      .toEqual([]);
  });

  it('refuses a body that writes Promise.resolve before its first child', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-replaced-resolve', async f => {
      await f.run('printf W');
      const original = Promise.resolve;
      Promise.resolve = ((value: unknown) => original.call(Promise, value)) as typeof Promise.resolve;
      try { await f.run('printf X'); }
      finally { Promise.resolve = original; }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toThrow(/lost its source certificate/u);
    expect(startedSpecs.slice(startedBefore).map(spec => spec['name']))
      .toEqual([]);
  });

  it('admits a parallel follow-up through the observed intrinsic Promise.all', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-observed-aggregate', async f => {
      await Promise.all([f.run('printf A'), f.run('printf B')]);
      await f.run('printf X');
      f.done('success');
    }), { executionMode: 'parallel' })).resolves.toMatchObject({ completionReason: 'success' });
    const admitted = startedSpecs.slice(startedBefore).map(spec => String(spec['name']));
    expect(admitted).toHaveLength(4);
    expect(admitted[2]).toMatch(/^parallel-observed-aggregate\/run-after-/u);
  });

  it('keeps observed async route branches parallel through their join', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-observed-routes', async f => {
      const left = async () => { await f.run('printf A'); await f.run('printf L'); };
      const right = async () => { await f.run('printf B'); await f.run('printf R'); };
      await Promise.all([left(), right()]);
      await f.run('printf X');
      f.done('success');
    }), { executionMode: 'parallel' })).resolves.toMatchObject({ completionReason: 'success' });
    expect(startedSpecs.slice(startedBefore)).toHaveLength(6);
  });

  it('keeps a caught parallel activity refusal as a root failure', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-hidden-activity', async f => {
      try { f.on(undefined as never, undefined as never); } catch { /* author swallowed refusal */ }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toMatchObject({ code: 'step_failed' });
    expect(startedSpecs).toHaveLength(startedBefore);
  });

  it('keeps a caught late zero-predecessor refusal as a root failure', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('parallel-hidden-late-run', async f => {
      await Promise.resolve();
      try { await f.run('printf hidden'); } catch { /* author swallowed refusal */ }
      f.done('success');
    }), { executionMode: 'parallel' })).rejects.toMatchObject({ code: 'step_failed' });
    expect(startedSpecs).toHaveLength(startedBefore);
  });

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
