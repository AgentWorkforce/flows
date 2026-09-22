import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { github } from '@relayflows/surface';
import {
  extensionHandlerForHostedDispatch,
  hostedExtensionDispatchIdentity,
} from '../src/flow-extension-loader.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/index.js';
import { hostedManifestRoutes } from '../src/hosted-extension-isolation.js';
import { sandboxArguments, supportsHostedSandboxFlags } from '../src/hosted-extension-sandbox.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('hosted extension routing policy', () => {
  it('accepts only Node releases that implement every sandbox flag', () => {
    expect(supportsHostedSandboxFlags('22.12.0')).toBe(false);
    expect(supportsHostedSandboxFlags('22.13.0')).toBe(true);
    expect(supportsHostedSandboxFlags('23.4.0')).toBe(false);
    expect(supportsHostedSandboxFlags('23.5.0')).toBe(true);
    expect(supportsHostedSandboxFlags('24.0.0')).toBe(true);
    expect(supportsHostedSandboxFlags('not-a-version')).toBe(false);
  });

  it('constructs the pinned Surface mounts without ambient array methods', () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-sandbox-arguments-'));
    roots.push(root);
    const facade = join(root, 'surface');
    for (const file of [
      'flow.js', 'helpers/providers.js', 'provider-trigger.js', 'schedule.js',
      'triggers.js', 'triggers/github.js',
    ]) {
      mkdirSync(join(facade, 'dist', file, '..'), { recursive: true });
      writeFileSync(join(facade, 'dist', file), file);
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
        node: '/trusted/node', runner: '/trusted/runner', extension: '/trusted/extension', surfaceFacade: facade,
      });
    } finally {
      Array.prototype.flatMap = flatMap;
      Array.prototype.push = push;
    }
    expect(calls).toBe(0);
    expect(args).not.toContain('/attacker');
    for (const file of [
      'flow.js', 'helpers/providers.js', 'provider-trigger.js', 'schedule.js',
      'triggers.js', 'triggers/github.js',
    ]) {
      expect(args).toContain(`/extension/node_modules/@relayflows/surface/dist/${file}`);
    }
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
