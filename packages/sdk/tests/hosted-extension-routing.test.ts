import { describe, expect, it } from 'vitest';
import { github } from '@relayflows/surface';
import {
  extensionHandlerForHostedDispatch,
  hostedExtensionDispatchIdentity,
} from '../src/flow-extension-loader.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/index.js';
import { hostedManifestRoutes } from '../src/hosted-extension-isolation.js';
import { sandboxArguments, supportsHostedSandboxFlags } from '../src/hosted-extension-sandbox.js';

describe('hosted extension routing policy', () => {
  it('accepts only Node releases that implement every sandbox flag', () => {
    expect(supportsHostedSandboxFlags('22.12.0')).toBe(false);
    expect(supportsHostedSandboxFlags('22.13.0')).toBe(true);
    expect(supportsHostedSandboxFlags('23.4.0')).toBe(false);
    expect(supportsHostedSandboxFlags('23.5.0')).toBe(true);
    expect(supportsHostedSandboxFlags('24.0.0')).toBe(true);
    expect(supportsHostedSandboxFlags('not-a-version')).toBe(false);
  });

  it('parses the captured Node version without ambient regex or number hooks', () => {
    const exec = RegExp.prototype.exec;
    const number = Number;
    let poisonCalls = 0;
    try {
      RegExp.prototype.exec = (() => {
        poisonCalls += 1;
        throw new Error('ambient RegExp.exec must not run');
      }) as typeof RegExp.prototype.exec;
      globalThis.Number = (() => {
        poisonCalls += 1;
        throw new Error('ambient Number must not run');
      }) as unknown as NumberConstructor;
      expect(supportsHostedSandboxFlags('24.0.0')).toBe(true);
    } finally {
      RegExp.prototype.exec = exec;
      globalThis.Number = number;
    }
    expect(poisonCalls).toBe(0);
  });

  it('constructs the pinned Surface mounts without ambient array methods', () => {
    const surfaceFiles = [
      'flow.js', 'helpers/providers.js', 'provider-trigger.js', 'schedule.js',
      'triggers.js', 'triggers/github.js',
    ];
    const dataDestinations = ['/runtime/runner.mjs', '/extension/src/babysitter.flow.ts'];
    for (let index = 0; index < surfaceFiles.length; index += 1) {
      dataDestinations[dataDestinations.length] = `/extension/node_modules/@relayflows/surface/dist/${surfaceFiles[index]!}`;
    }
    const flatMap = Array.prototype.flatMap;
    const push = Array.prototype.push;
    let calls = 0;
    let args: string[] | undefined;
    try {
      Array.prototype.flatMap = function poisonedFlatMap(
        this: unknown[],
        callback: (value: unknown, index: number, array: unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        if (this.length === 6 && this[0] === 'flow.js') {
          calls += 1;
          return ['--bind', '/attacker', '/runtime/runner.mjs'] as never[];
        }
        return Reflect.apply(flatMap, this, [callback, thisArg]) as never[];
      } as typeof Array.prototype.flatMap;
      Array.prototype.push = function poisonedPush(this: unknown[], ...values: unknown[]) {
        if (this[0] === '--unshare-all') {
          calls += 1;
          return this.length;
        }
        return Reflect.apply(push, this, values);
      } as typeof Array.prototype.push;
      args = sandboxArguments({
        node: '/trusted/node', dataDestinations,
      });
    } finally {
      Array.prototype.flatMap = flatMap;
      Array.prototype.push = push;
    }
    expect(calls).toBe(0);
    expect(args).not.toContain('/attacker');
    for (const file of surfaceFiles) {
      expect(args).toContain(`/extension/node_modules/@relayflows/surface/dist/${file}`);
    }
    expect(args).toContain('--ro-bind-data');
    expect(args).not.toContain('/trusted/extension');
  });

  it('matches the SDK router for exact, absent, duplicate, and generic-overlap routes', () => {
    const body = async () => {};
    const specific = { name: 'specific', handlers: [{ trigger: github.pull_request('labeled'), body }] };
    const duplicate = { name: 'duplicate', handlers: [{ trigger: github.pull_request('labeled'), body }] };
    const generic = { name: 'generic', handlers: [{ trigger: github.pull_request(), body }] };
    const labeled = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    const edited = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.edited', deliveryId: 'delivery-2',
    });
    expect(extensionHandlerForHostedDispatch(labeled, [specific])?.extension.name).toBe('specific');
    expect(hostedManifestRoutes(
      { triggers: [{ provider: 'github', event: 'pull_request', actions: ['labeled'] }] },
      { provider: 'github', event: 'pull_request', action: 'labeled' },
    )).toBe(true);
    expect(extensionHandlerForHostedDispatch(edited, [specific])).toBeUndefined();
    expect(hostedManifestRoutes(
      { triggers: [{ provider: 'github', event: 'pull_request', actions: ['labeled'] }] },
      { provider: 'github', event: 'pull_request', action: 'edited' },
    )).toBe(false);
    expect(() => extensionHandlerForHostedDispatch(labeled, [specific, duplicate]))
      .toThrow(expect.objectContaining({ code: 'plugin_event_ambiguous' }));
    expect(() => extensionHandlerForHostedDispatch(labeled, [specific, generic]))
      .toThrow(expect.objectContaining({ code: 'plugin_event_ambiguous' }));
    expect(() => extensionHandlerForHostedDispatch({
      provenance: 'integration-watch', provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    }, [specific])).toThrow(expect.objectContaining({ code: 'plugin_event_unroutable' }));
  });

  it('keeps the refusal match when Array.prototype has an inherited numeric setter', () => {
    const body = async () => {};
    const handler = { trigger: github.pull_request('labeled'), body };
    const extension = { name: 'specific', handlers: [handler] };
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-setter',
    });
    const defineProperty = Object.defineProperty;
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    let poisonCalls = 0;
    let selected: ReturnType<typeof extensionHandlerForHostedDispatch>;
    try {
      defineProperty(Array.prototype, '0', {
        configurable: true,
        set(this: unknown[], value: unknown) {
          const match = value as { extension?: unknown; handler?: unknown } | null;
          if (match !== null && typeof match === 'object'
            && match.extension === extension && match.handler === handler) {
            poisonCalls += 1;
            return;
          }
          defineProperty(this, '0', {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
          });
        },
      });
      selected = extensionHandlerForHostedDispatch(dispatch, [extension]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Array.prototype, '0');
      else defineProperty(Array.prototype, '0', previous);
    }
    expect(poisonCalls).toBe(0);
    expect(selected?.extension).toBe(extension);
    expect(selected?.handler).toBe(handler);
  });

  it('parses and routes dispatch authority with captured intrinsics', () => {
    const body = async () => {};
    const extension = { name: 'specific', handlers: [{ trigger: github.pull_request('labeled'), body }] };
    const originals = {
      freeze: Object.freeze,
      split: String.prototype.split,
      test: RegExp.prototype.test,
      some: Array.prototype.some,
      flatMap: Array.prototype.flatMap,
    };
    let poisonCalls = 0;
    let identity: ReturnType<typeof hostedExtensionDispatchIdentity> | undefined;
    let selected: ReturnType<typeof extensionHandlerForHostedDispatch>;
    try {
      Object.freeze = (() => { poisonCalls += 1; throw new Error('ambient freeze'); }) as typeof Object.freeze;
      String.prototype.split = (() => { poisonCalls += 1; return ['forged']; }) as typeof String.prototype.split;
      RegExp.prototype.test = (() => { poisonCalls += 1; return false; }) as typeof RegExp.prototype.test;
      Array.prototype.some = (() => { poisonCalls += 1; return true; }) as typeof Array.prototype.some;
      Array.prototype.flatMap = (() => { poisonCalls += 1; return []; }) as typeof Array.prototype.flatMap;
      const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
        provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-poison',
      });
      identity = hostedExtensionDispatchIdentity(dispatch);
      selected = extensionHandlerForHostedDispatch(dispatch, [extension]);
    } finally {
      Object.freeze = originals.freeze;
      String.prototype.split = originals.split;
      RegExp.prototype.test = originals.test;
      Array.prototype.some = originals.some;
      Array.prototype.flatMap = originals.flatMap;
    }
    expect(poisonCalls).toBe(0);
    expect(identity).toEqual({ provider: 'github', event: 'pull_request', action: 'labeled' });
    expect(selected?.extension).toBe(extension);
  });
});
