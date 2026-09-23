import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/index.js';
import {
  runVerifiedNativeExtensionSandbox,
  type HostedExtensionArtifact,
} from '../src/hosted-extension-isolation.js';
import {
  boundedJsonSnapshot,
  exchangeHostedExtension,
} from '../src/hosted-extension-protocol.js';
import { snapshotJsonValue } from '../src/json-value.js';
import { validateFlowExtensionManifest } from '../src/flow-extension-manifest.js';
import { materializePlugin } from '../src/plugin-store.js';

const roots: string[] = [];
const require = createRequire(import.meta.url);
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const manifest = () => ({
  schema: 2,
  kind: 'flow-extension',
  name: 'babysitter',
  version: '0.2.0',
  compat: { surface: '*', sdk: '*', base: [{ name: 'software-factory', version: '*' }] },
  entry: 'babysitter.flow.ts',
  extends: { handlers: true, hooks: [] },
  triggers: [
    { provider: 'github', event: 'pull_request', actions: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'closed', 'labeled', 'unlabeled'] },
    { provider: 'github', event: 'pull_request_review', actions: ['submitted', 'dismissed'] },
    { provider: 'github', event: 'check_run', actions: ['completed'] },
    { provider: 'github', event: 'issue_comment', actions: ['created'] },
  ],
  permissions: {
    integrations: ['github'], harnesses: ['codex'], mcp: [], writes: ['cloud:babysitter-turn'],
    budget: { dollars: 1, wallclock: '5m' },
  },
  preflight: { credentials: [], servers: [] },
});

function descriptor() {
  return {
    event: { provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1' },
    pullRequest: { owner: 'AgentWorkforce', repo: 'flows', number: 551 },
  };
}

async function artifact(source: string): Promise<HostedExtensionArtifact> {
  const root = mkdtempSync(join(tmpdir(), 'hosted-protocol-test-'));
  roots.push(root);
  const manifestBytes = Buffer.from(JSON.stringify(manifest()));
  const stored = await materializePlugin(root, 'babysitter', [
    { path: 'flows-plugin.json', data: manifestBytes },
    { path: 'babysitter.flow.ts', data: Buffer.from(source) },
  ]);
  return {
    ref: `github:AgentWorkforce/flows@${'a'.repeat(40)}#extensions/babysitter`,
    name: 'babysitter', version: '0.2.0', directory: stored.directory, digest: stored.digest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
}

function capabilityFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'capability', id: 1, name: 'cloud:babysitter-turn',
    request: { delivery: {
      deliveryId: 'delivery-1', provider: 'github', eventType: 'pull_request.labeled',
      pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 551 },
      ...overrides,
    } },
  };
}

function hostileImport(frames: readonly unknown[]): string {
  const writes = frames.map(frame => `writeSync(3, ${JSON.stringify(`${JSON.stringify(frame)}\n`)});`).join('\n');
  return `
    import { writeSync } from 'node:fs';
    import { flow, github } from '@relayflows/surface';
    ${writes}
    export default flow('babysitter', async f => f.done('declined'))
      .on(github.pull_request('labeled'), async () => { await new Promise(() => {}); });
  `;
}

function normalImport(): string {
  return `
    import { flow, github } from '@relayflows/surface';
    export default flow('babysitter', async f => f.done('declined'))
      .on(github.pull_request('labeled'), async (f, input) => {
        await f.capabilities.cloud.babysitterTurn.queue({ delivery: {
          deliveryId: input.event.deliveryId,
          provider: input.event.provider,
          eventType: input.event.eventType,
          pullRequest: {
            owner: input.pullRequest.owner,
            repository: input.pullRequest.repo,
            number: input.pullRequest.number,
          },
        } });
        f.done('success');
      });
  `;
}

const dispatch = () => hostedExtensionDispatchFromVerifiedDelivery({
  provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
});

async function waitForInvocation(invoked: Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('hostile child did not invoke the adapter')), 10_000);
    void invoked.then(() => { clearTimeout(timeout); resolve(); }, reject);
  });
}

describe('hosted extension hostile protocol', () => {
  it('counts a control followed by a low surrogate as two JSON escapes', () => {
    expect(() => snapshotJsonValue('\0\udc00', 'delivery', {
      maxDepth: 4, maxNodes: 4, maxBytes: 13,
    })).toThrow(/snapshot byte limit exceeded/);
  });

  it('caps object cardinality without materializing the complete key list', () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 10_000; index += 1) hostile[`ignored-${index}`] = undefined;
    const started = Date.now();
    expect(() => snapshotJsonValue(hostile, 'delivery', {
      maxDepth: 4, maxNodes: 32, maxBytes: 1024,
    })).toThrow(/snapshot depth or node limit exceeded/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('copies only JSON-visible metadata into the behavior-free snapshot', () => {
    const value = { visible: 'yes' } as Record<PropertyKey, unknown>;
    Object.defineProperty(value, 'hidden', { value: 'no', enumerable: false });
    value[Symbol('hidden')] = 'no';
    expect(snapshotJsonValue(value, 'delivery')).toEqual({ visible: 'yes' });
  });

  it('rejects a Proxy in an array prototype chain without executing its traps', () => {
    let traps = 0;
    const prototype = new Proxy(Array.prototype, {
      ownKeys: () => { traps += 1; return []; },
      getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
    });
    const value: unknown[] = [];
    Object.setPrototypeOf(value, prototype);
    expect(() => snapshotJsonValue(value, 'delivery')).toThrow(/intrinsic prototype/);
    expect(traps).toBe(0);
  });

  it('uses the captured proxy detector after builtin export synchronization', () => {
    const builtinUtil = require('node:util') as typeof import('node:util');
    const originalIsProxy = builtinUtil.types.isProxy;
    let poisonCalls = 0;
    try {
      builtinUtil.types.isProxy = (() => {
        poisonCalls += 1;
        return false;
      }) as typeof builtinUtil.types.isProxy;
      syncBuiltinESMExports();
      expect(() => snapshotJsonValue(new Proxy({}, {}), 'delivery')).toThrow(/Proxy objects are not allowed/);
    } finally {
      builtinUtil.types.isProxy = originalIsProxy;
      syncBuiltinESMExports();
    }
    expect(poisonCalls).toBe(0);
  });

  it('shadows a poisoned Array.prototype.toJSON on copied arrays', () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let calls = 0;
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => { calls += 1; return 'x'.repeat(1024 * 1024); },
      });
      const snapshot = snapshotJsonValue(['safe'], 'delivery', {
        maxDepth: 4, maxNodes: 4, maxBytes: 32,
      });
      expect(JSON.stringify(snapshot)).toBe('["safe"]');
      expect(calls).toBe(0);
    } finally {
      if (previous === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, 'toJSON', previous);
    }
  });

  it('uses captured byte-counting intrinsics', () => {
    const byteLength = Object.getOwnPropertyDescriptor(Buffer, 'byteLength')!;
    const charCodeAt = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!;
    let calls = 0;
    try {
      Object.defineProperty(Buffer, 'byteLength', {
        ...byteLength, value: () => { calls += 1; return 0; },
      });
      Object.defineProperty(String.prototype, 'charCodeAt', {
        ...charCodeAt, value: () => { calls += 1; return 0; },
      });
      expect(boundedJsonSnapshot({ delivery: 'safe' }, 'delivery')).toEqual({ delivery: 'safe' });
    } finally {
      Object.defineProperty(Buffer, 'byteLength', byteLength);
      Object.defineProperty(String.prototype, 'charCodeAt', charCodeAt);
    }
    expect(calls).toBe(0);
  });

  it.each(['inherited toJSON', 'stateful getter'] as const)(
    'refuses a delivery descriptor with %s before the adapter', async attack => {
      const input = descriptor();
      let hostile: unknown = input;
      if (attack === 'inherited toJSON') {
        hostile = Object.assign(Object.create({
          toJSON: () => ({ ...input, pullRequest: { owner: 'attacker', repo: 'other', number: 999 } }),
        }), input);
      } else {
        Object.defineProperty(input.pullRequest, 'owner', {
          enumerable: true,
          get: () => 'AgentWorkforce',
        });
      }
      let calls = 0;
      await expect(runVerifiedNativeExtensionSandbox({
        artifact: await artifact(normalImport()),
        manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: hostile,
        babysitterTurn: { queue: async () => {
          calls += 1;
          return { receiptId: 'never', status: 'queued' };
        } },
      })).rejects.toMatchObject({ code: 'plugin_unsupported' });
      expect(calls).toBe(0);
    },
  );

  it('bounds an exponentially shared delivery graph before cloning it', async () => {
    let shared: Record<string, unknown> = { leaf: 'x' };
    for (let depth = 0; depth < 40; depth += 1) shared = { left: shared, right: shared };
    const input = { ...descriptor(), extra: shared };
    let calls = 0;
    const started = Date.now();
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(normalImport()),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input,
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'never', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(0);
  });

  it('rejects an oversized escaped string before materializing its JSON encoding', async () => {
    const input = { ...descriptor(), extra: '\0'.repeat(1024 * 1024) };
    let calls = 0;
    const started = Date.now();
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(normalImport()),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input,
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'never', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(0);
  });

  it('rejects extra delivery fields with Array.prototype.sort poisoned', async () => {
    const installed = await artifact(normalImport());
    const validated = validateFlowExtensionManifest(manifest());
    const input = { ...descriptor(), sessionId: 'forged-session' };
    const sort = Object.getOwnPropertyDescriptor(Array.prototype, 'sort')!;
    let calls = 0;
    try {
      Object.defineProperty(Array.prototype, 'sort', { ...sort, value: () => [] });
      await expect(runVerifiedNativeExtensionSandbox({
        artifact: installed, manifest: validated, dispatch: dispatch(), input,
        babysitterTurn: { queue: async () => {
          calls += 1;
          return { receiptId: 'never', status: 'queued' };
        } },
      })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
    } finally {
      Object.defineProperty(Array.prototype, 'sort', sort);
    }
    expect(calls).toBe(0);
  });

  it.runIf(process.platform === 'linux')(
    'uses captured JSON intrinsics for the complete parent boundary', async () => {
      const installed = await artifact(normalImport());
      const validated = validateFlowExtensionManifest(manifest());
      const trustedDispatch = dispatch();
      const stringify = Object.getOwnPropertyDescriptor(JSON, 'stringify')!;
      const parse = Object.getOwnPropertyDescriptor(JSON, 'parse')!;
      const calls: unknown[] = [];
      let result: Awaited<ReturnType<typeof runVerifiedNativeExtensionSandbox>>;
      try {
        Object.defineProperty(JSON, 'stringify', { ...stringify, value: () => '{"forged":true}' });
        Object.defineProperty(JSON, 'parse', { ...parse, value: () => ({ forged: true }) });
        result = await runVerifiedNativeExtensionSandbox({
          artifact: installed,
          manifest: validated,
          dispatch: trustedDispatch,
          input: descriptor(),
          babysitterTurn: { queue: async request => {
            calls.push(request);
            return { receiptId: 'receipt-1', status: 'queued' };
          } },
        });
      } finally {
        Object.defineProperty(JSON, 'stringify', stringify);
        Object.defineProperty(JSON, 'parse', parse);
      }
      expect(result!).toEqual({ completionReason: 'success', capabilityCalls: 1 });
      expect(calls).toEqual([{ delivery: {
        deliveryId: 'delivery-1', provider: 'github', eventType: 'pull_request.labeled',
        pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 551 },
      } }]);
    },
  );

  it('rejects completion while an exact direct call is pending', async () => {
    let settle!: (value: unknown) => void;
    const adapter = new Promise(resolve => { settle = resolve; });
    let markInvoked!: () => void;
    const invoked = new Promise<void>(resolve => { markInvoked = resolve; });
    let calls = 0;
    const protocol = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    const run = exchangeHostedExtension(
      child,
      protocol,
      stdin,
      stderr,
      10_000,
      { type: 'run' },
      async () => { calls += 1; markInvoked(); return await adapter; },
    );
    protocol.write(`${JSON.stringify(capabilityFrame())}\n${JSON.stringify({
      type: 'result', completionReason: 'success', capabilityCalls: 1,
    })}\n`);
    await waitForInvocation(invoked);
    settle({ receiptId: 'settled-after-refusal', status: 'queued' });
    await expect(run).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(1);
  }, 15_000);

  it('settles successful completion with captured intrinsics', async () => {
    const protocol = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    const freeze = Object.freeze;
    const then = Promise.prototype.then;
    const adapter = Promise.resolve({ receiptId: 'receipt-captured-intrinsics', status: 'queued' });
    let poisonCalls = 0;
    let result: Awaited<ReturnType<typeof exchangeHostedExtension>> | undefined;
    try {
      Object.freeze = ((value: object) => {
        if ('completionReason' in value) {
          poisonCalls += 1;
          return { completionReason: 'forged', capabilityCalls: 0 } as typeof value;
        }
        return freeze(value);
      }) as typeof Object.freeze;
      Promise.prototype.then = function poisonedThen(this: Promise<unknown>, onfulfilled, onrejected) {
        if (this === adapter) {
          poisonCalls += 1;
          onfulfilled?.({ receiptId: 'forged', status: 'queued' });
          return Promise.resolve(undefined) as Promise<unknown>;
        }
        return Reflect.apply(then, this, [onfulfilled, onrejected]) as Promise<unknown>;
      } as typeof Promise.prototype.then;
      stdin.on('data', chunk => {
        if (String(chunk).includes('capability-result')) {
          protocol.write(`${JSON.stringify({
            type: 'result', completionReason: 'success', capabilityCalls: 1,
          })}\n`);
        }
      });
      const run = exchangeHostedExtension(
        child, protocol, stdin, stderr, 10_000, { type: 'run' },
        () => adapter,
      );
      protocol.write(`${JSON.stringify(capabilityFrame())}\n`);
      result = await run;
    } finally {
      Object.freeze = freeze;
      Promise.prototype.then = then;
    }
    expect(poisonCalls).toBe(0);
    expect(result).toEqual({ completionReason: 'success', capabilityCalls: 1 });
  });

  it('rejects non-object protocol output with zero adapter calls', async () => {
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(hostileImport([null])),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(),
      babysitterTurn: { queue: async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(0);
  });

  it.each([
    ['different PR', capabilityFrame({ pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 999 } })],
    ['different delivery', capabilityFrame({ deliveryId: 'delivery-2' })],
    ['different event', capabilityFrame({ eventType: 'pull_request.opened' })],
  ])('rejects an import-time %s frame with zero adapter calls', async (_case, frame) => {
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(hostileImport([frame, { type: 'error', message: 'forged terminal' }])),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(), timeoutMs: 1_000,
      babysitterTurn: { queue: async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; } },
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
    expect(calls).toBe(0);
  });

  it('rejects a forged result before any capability call', async () => {
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(hostileImport([{ type: 'result', completionReason: 'success', capabilityCalls: 1 }])),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(),
      babysitterTurn: { queue: async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(0);
  });

  it('rejects two forged calls after the authoritative first outcome settles', async () => {
    let settle!: (value: unknown) => void;
    const adapter = new Promise(resolve => { settle = resolve; });
    let markInvoked!: () => void;
    const invoked = new Promise<void>(resolve => { markInvoked = resolve; });
    let calls = 0;
    const run = runVerifiedNativeExtensionSandbox({
      artifact: await artifact(hostileImport([capabilityFrame(), capabilityFrame()])),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(), timeoutMs: 10_000,
      babysitterTurn: { queue: async () => {
        calls += 1;
        markInvoked();
        return await adapter;
      } },
    });
    await waitForInvocation(invoked);
    settle({ receiptId: 'settled', status: 'queued' });
    await expect(run).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(1);
  }, 15_000);

  it.each(['reject', 'resolve'] as const)(
    'waits for a pending adapter to %s after a forged child error', async outcome => {
      const refusal = Object.assign(new Error('typed Cloud refusal'), { code: 'cloud_policy_refusal' });
      let settle!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const adapter = new Promise((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise; });
      let markInvoked!: () => void;
      const invoked = new Promise<void>(resolve => { markInvoked = resolve; });
      let completed = false;
      const run = runVerifiedNativeExtensionSandbox({
        artifact: await artifact(hostileImport([capabilityFrame(), { type: 'error', message: 'premature' }])),
        manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(), timeoutMs: 1_000,
        babysitterTurn: { queue: async () => { markInvoked(); return await adapter; } },
      }).finally(() => { completed = true; });
      const observed = run.then(() => undefined, error => error as Error);
      await waitForInvocation(invoked);
      expect(completed).toBe(false);
      if (outcome === 'reject') reject(refusal);
      else settle({ receiptId: 'settled', status: 'queued' });
      const error = await observed;
      if (outcome === 'reject') expect(error).toBe(refusal);
      else expect(error).toMatchObject({ code: 'plugin_unsupported' });
    }, 15_000,
  );

  it('returns a typed adapter rejection even when the hostile child hangs', async () => {
    const refusal = Object.assign(new Error('typed Cloud refusal'), { code: 'cloud_policy_refusal' });
    let rejectAdapter!: (error: Error) => void;
    const adapter = new Promise<never>((_resolve, reject) => { rejectAdapter = reject; });
    let markInvoked!: () => void;
    const invoked = new Promise<void>(resolve => { markInvoked = resolve; });
    let calls = 0;
    const run = runVerifiedNativeExtensionSandbox({
      artifact: await artifact(hostileImport([capabilityFrame()])),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(), timeoutMs: 10_000,
      babysitterTurn: { queue: async () => { calls += 1; markInvoked(); return await adapter; } },
    });
    const observed = run.then(() => undefined, error => error as Error);
    await waitForInvocation(invoked);
    rejectAdapter(refusal);
    expect(await observed).toBe(refusal);
    expect(calls).toBe(1);
  }, 15_000);
});
