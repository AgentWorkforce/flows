import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
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

it('registers and completes protocol I/O with captured stream operations', async () => {
  const eventOn = EventEmitter.prototype.on;
  const eventOnce = EventEmitter.prototype.once;
  const setEncoding = Readable.prototype.setEncoding;
  const resume = Readable.prototype.resume;
  const write = Writable.prototype.write;
  const end = Writable.prototype.end;
  const protocol = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  let poisonCalls = 0;
  let adapterCalls = 0;
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => { poisonCalls += 1; return true; },
  }) as unknown as ChildProcess;
  let rejection: unknown;
  try {
    EventEmitter.prototype.on = function poisonedOn(this: EventEmitter, ...args) {
      poisonCalls += 1;
      return Reflect.apply(eventOn, this, args);
    } as typeof EventEmitter.prototype.on;
    EventEmitter.prototype.once = function poisonedOnce(this: EventEmitter, ...args) {
      poisonCalls += 1;
      return Reflect.apply(eventOnce, this, args);
    } as typeof EventEmitter.prototype.once;
    Readable.prototype.setEncoding = function poisonedSetEncoding(this: Readable, ...args) {
      poisonCalls += 1;
      return Reflect.apply(setEncoding, this, args);
    } as typeof Readable.prototype.setEncoding;
    Readable.prototype.resume = function poisonedResume(this: Readable, ...args) {
      poisonCalls += 1;
      return Reflect.apply(resume, this, args);
    } as typeof Readable.prototype.resume;
    Writable.prototype.write = function poisonedWrite(this: Writable, ...args) {
      poisonCalls += 1;
      return Reflect.apply(write, this, args);
    } as typeof Writable.prototype.write;
    Writable.prototype.end = function poisonedEnd(this: Writable, ...args) {
      poisonCalls += 1;
      return Reflect.apply(end, this, args);
    } as typeof Writable.prototype.end;

    const run = exchangeHostedExtension(
      child, protocol, stdin, stderr, 10_000, { type: 'run' },
      async () => {
        adapterCalls += 1;
        return { receiptId: 'must-not-run', status: 'queued' };
      },
    );
    Reflect.apply(write, protocol, ['{}\n']);
    try { await run; } catch (error) { rejection = error; }
  } finally {
    EventEmitter.prototype.on = eventOn;
    EventEmitter.prototype.once = eventOnce;
    Readable.prototype.setEncoding = setEncoding;
    Readable.prototype.resume = resume;
    Writable.prototype.write = write;
    Writable.prototype.end = end;
  }
  expect(rejection).toMatchObject({ code: 'plugin_unsupported' });
  expect({ poisonCalls, adapterCalls }).toEqual({ poisonCalls: 0, adapterCalls: 0 });
});

it('serializes protocol envelopes without inherited toJSON behavior', async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const protocol = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
  let poisonCalls = 0;
  let adapterCalls = 0;
  stdin.on('data', chunk => {
    if (String(chunk).includes('capability-result')) {
      protocol.write('{"type":"result","completionReason":"success","capabilityCalls":1}\n');
    }
  });

  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        poisonCalls += 1;
        throw new Error('ambient Object.prototype.toJSON must not run');
      },
    });
    const run = exchangeHostedExtension(
      child, protocol, stdin, stderr, 10_000, { type: 'execute', identity: { provider: 'github' } },
      async () => {
        adapterCalls += 1;
        return { receiptId: 'receipt-to-json', status: 'queued' };
      },
    );
    protocol.write('{"type":"capability","id":1,"name":"cloud:babysitter-turn","request":{"delivery":"exact"}}\n');
    await expect(run).resolves.toEqual({ completionReason: 'success', capabilityCalls: 1 });
  } finally {
    if (previous === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
    else Object.defineProperty(Object.prototype, 'toJSON', previous);
  }
  expect({ poisonCalls, adapterCalls }).toEqual({ poisonCalls: 0, adapterCalls: 1 });
});

it('rejects frames without consulting an inherited type discriminator', async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'type');
  const protocol = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
  let poisonCalls = 0;
  let adapterCalls = 0;
  try {
    Object.defineProperty(Object.prototype, 'type', {
      configurable: true,
      get: () => {
        const caller = (new Error().stack ?? '').split('\n', 4)[3] ?? '';
        if (caller.includes('/src/hosted-extension-protocol.')) poisonCalls += 1;
        return 'capability';
      },
    });
    const run = exchangeHostedExtension(
      child, protocol, stdin, stderr, 10_000, { type: 'execute' },
      async () => {
        adapterCalls += 1;
        return { receiptId: 'must-not-run', status: 'queued' };
      },
    );
    protocol.write('{}\n');
    await expect(run).rejects.toMatchObject({ code: 'plugin_unsupported' });
  } finally {
    if (previous === undefined) delete (Object.prototype as { type?: unknown }).type;
    else Object.defineProperty(Object.prototype, 'type', previous);
  }
  expect({ poisonCalls, adapterCalls }).toEqual({ poisonCalls: 0, adapterCalls: 0 });
});
