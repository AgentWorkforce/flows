import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/index.js';
import {
  runVerifiedNativeExtensionSandbox,
  type HostedExtensionArtifact,
} from '../src/hosted-extension-isolation.js';
import { validateFlowExtensionManifest } from '../src/flow-extension-manifest.js';
import { materializePlugin } from '../src/plugin-store.js';

const roots: string[] = [];
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

const dispatch = () => hostedExtensionDispatchFromVerifiedDelivery({
  provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
});

describe('hosted extension hostile protocol', () => {
  it('rejects completion while an exact direct call is pending', async () => {
    let settle!: (value: unknown) => void;
    const adapter = new Promise(resolve => { settle = resolve; });
    let calls = 0;
    setTimeout(() => settle({ receiptId: 'settled-after-refusal', status: 'queued' }), 20);
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(hostileImport([
        capabilityFrame(),
        { type: 'result', completionReason: 'success', capabilityCalls: 1 },
      ])),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(), timeoutMs: 1_000,
      babysitterTurn: { queue: async () => { calls += 1; return await adapter; } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(1);
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
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(hostileImport([capabilityFrame(), capabilityFrame()])),
      manifest: validateFlowExtensionManifest(manifest()), dispatch: dispatch(), input: descriptor(), timeoutMs: 1_000,
      babysitterTurn: { queue: async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { receiptId: 'settled', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(1);
  });

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
      await invoked;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(completed).toBe(false);
      if (outcome === 'reject') reject(refusal);
      else settle({ receiptId: 'settled', status: 'queued' });
      const error = await observed;
      if (outcome === 'reject') expect(error).toBe(refusal);
      else expect(error).toMatchObject({ code: 'plugin_unsupported' });
    },
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
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('hostile child did not invoke the adapter')),
        10_000,
      );
      void invoked.then(() => { clearTimeout(timeout); resolve(); }, reject);
    });
    rejectAdapter(refusal);
    expect(await observed).toBe(refusal);
    expect(calls).toBe(1);
  }, 15_000);
});
