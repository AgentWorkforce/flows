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
