import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { exchangeHostedExtension } from '../src/hosted-extension-protocol.js';

it('constructs protocol completion with the captured Promise', async () => {
  const NativePromise = Promise;
  const protocol = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
  let adapterCalls = 0;
  let poisonCalls = 0;
  stdin.on('data', chunk => {
    if (String(chunk).includes('capability-result')) {
      protocol.write(`${JSON.stringify({
        type: 'result', completionReason: 'success', capabilityCalls: 1,
      })}\n`);
    }
  });

  class PoisonedPromise<T> extends NativePromise<T> {
    constructor(executor: ConstructorParameters<typeof NativePromise<T>>[0]) {
      poisonCalls += 1;
      super(executor);
      return NativePromise.resolve({
        completionReason: 'success', capabilityCalls: 1,
      }) as unknown as PoisonedPromise<T>;
    }
  }

  let run!: ReturnType<typeof exchangeHostedExtension>;
  try {
    globalThis.Promise = PoisonedPromise as PromiseConstructor;
    run = exchangeHostedExtension(
      child, protocol, stdin, stderr, 10_000, { type: 'run' },
      async () => {
        adapterCalls += 1;
        return { receiptId: 'receipt-captured-constructor', status: 'queued' };
      },
    );
  } finally {
    globalThis.Promise = NativePromise;
  }

  protocol.write(`${JSON.stringify({
    type: 'capability', id: 1, name: 'cloud:babysitter-turn', request: { delivery: 'exact' },
  })}\n`);
  await expect(run).resolves.toEqual({ completionReason: 'success', capabilityCalls: 1 });
  expect(adapterCalls).toBe(1);
  expect(poisonCalls).toBe(0);
});

it('enforces the protocol deadline with captured timer operations', async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const sample = nativeSetTimeout(() => undefined, 60_000);
  nativeClearTimeout(sample);
  const timerPrototype = Object.getPrototypeOf(sample) as { unref: () => unknown };
  const nativeUnref = timerPrototype.unref;
  const protocol = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
  let setTimeoutCalls = 0;
  let clearTimeoutCalls = 0;
  let unrefCalls = 0;
  let unrefCallsDuringSetup = 0;
  try {
    globalThis.setTimeout = (() => {
      setTimeoutCalls += 1;
      return { unref: () => { unrefCalls += 1; } };
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => { clearTimeoutCalls += 1; }) as typeof clearTimeout;
    timerPrototype.unref = () => { unrefCalls += 1; };
    const run = exchangeHostedExtension(
      child, protocol, stdin, stderr, 5, { type: 'run' },
      async () => ({ receiptId: 'never', status: 'queued' }),
    );
    unrefCallsDuringSetup = unrefCalls;
    timerPrototype.unref = nativeUnref;
    await expect(run).rejects.toMatchObject({ code: 'plugin_unsupported' });
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    timerPrototype.unref = nativeUnref;
  }
  expect({ setTimeoutCalls, clearTimeoutCalls, unrefCallsDuringSetup }).toEqual({
    setTimeoutCalls: 0,
    clearTimeoutCalls: 0,
    unrefCallsDuringSetup: 0,
  });
});
