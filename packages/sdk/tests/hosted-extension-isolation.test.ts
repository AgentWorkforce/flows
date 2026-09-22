import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/flow-extension-loader.js';
import {
  loadHostedExtensionArtifacts,
  runHostedCapabilityExtension,
  type HostedExtensionArtifact,
} from '../src/hosted-extension-isolation.js';
import { materializePlugin } from '../src/plugin-store.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const manifest = (writes: string[] = ['cloud:babysitter-turn']) => ({
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
    integrations: ['github'], harnesses: ['codex'], mcp: [], writes,
    budget: { dollars: 1, wallclock: '5m' },
  },
  preflight: { credentials: [], servers: [] },
});

const ordinaryExtension = `
import { flow, github } from '@relayflows/surface';
export default flow('babysitter', async f => f.done('declined'))
  .on(github.pull_request('labeled'), async (f, input) => {
    const receipt = await f.capabilities.cloud.babysitterTurn.queue({ delivery: {
      deliveryId: input.event.deliveryId,
      provider: input.event.provider,
      eventType: input.event.eventType,
      pullRequest: { owner: input.pullRequest.owner, repository: input.pullRequest.repo, number: input.pullRequest.number },
    } });
    if (!receipt || !['queued', 'duplicate'].includes(receipt.status)) throw new Error('bad receipt');
    f.done('success');
  });
`;

function descriptor(deliveryId = 'delivery-1') {
  return {
    event: { provider: 'github', eventType: 'pull_request.labeled', deliveryId },
    pullRequest: { owner: 'AgentWorkforce', repo: 'flows', number: 551 },
  };
}

async function artifact(source = ordinaryExtension, value = manifest()): Promise<HostedExtensionArtifact> {
  const root = mkdtempSync(join(tmpdir(), 'hosted-extension-test-')); roots.push(root);
  const manifestBytes = Buffer.from(JSON.stringify(value));
  const stored = await materializePlugin(root, 'babysitter', [
    { path: 'flows-plugin.json', data: manifestBytes },
    { path: 'babysitter.flow.ts', data: Buffer.from(source) },
  ]);
  return {
    ref: `github:AgentWorkforce/flows@${'a'.repeat(40)}#extensions/babysitter`,
    name: 'babysitter',
    version: '0.2.0',
    directory: stored.directory,
    digest: stored.digest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
}

describe('hosted extension capability isolation', () => {
  it('resolves locked artifacts without importing extension top-level code', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'hosted-loader-marker-')), 'imported');
    roots.push(marker.slice(0, marker.lastIndexOf('/')));
    const installed = await artifact(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'imported');
      ${ordinaryExtension}
    `);
    const root = resolve(installed.directory, '../../..');
    writeFileSync(join(root, 'flows.json'), JSON.stringify({ plugins: [installed.ref] }));
    writeFileSync(join(root, 'flows.lock.json'), JSON.stringify({
      version: 2,
      plugins: [{
        name: 'babysitter', kind: 'flow-extension', version: '0.2.0',
        source: {
          host: 'github', owner: 'AgentWorkforce', repo: 'flows',
          sha: 'a'.repeat(40), path: 'extensions/babysitter',
        },
        digest: installed.digest, manifestSha256: installed.manifestSha256,
        order: 1, resolvedAt: '2026-09-22T12:00:00.000Z',
      }],
    }));
    expect(await loadHostedExtensionArtifacts(join(root, 'software-factory.flow.ts'))).toEqual([installed]);
    expect(() => readFileSync(marker)).toThrow();
  });

  it.each(['queued', 'duplicate'] as const)('executes the exact capability-only handler for a %s receipt', async status => {
    const installed = await artifact();
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    const calls: unknown[] = [];
    const result = await runHostedCapabilityExtension({
      artifact: installed, dispatch, input: descriptor(),
      babysitterTurn: {
        queue: async (request, authority) => {
          calls.push(request);
          expect(authority.dispatch).toBe(dispatch);
          expect(authority.extension).toMatchObject({ name: 'babysitter', version: '0.2.0', digest: installed.digest });
          return { receiptId: 'receipt-1', status };
        },
      },
    });
    expect(result).toEqual({ completionReason: 'success', capabilityCalls: 1 });
    expect(calls).toEqual([{ delivery: {
      deliveryId: 'delivery-1', provider: 'github', eventType: 'pull_request.labeled',
      pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 551 },
    } }]);
  });

  it('denies ambient credentials, host files, writes, network, subprocesses, and undeclared context verbs', async () => {
    const sentinel = join(mkdtempSync(join(tmpdir(), 'hosted-sentinel-')), 'secret.txt');
    roots.push(sentinel.slice(0, sentinel.lastIndexOf('/')));
    writeFileSync(sentinel, 'host-secret');
    const escaped = `${sentinel}.escaped`;
    const source = `
import { flow, github } from '@relayflows/surface';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const denied = async fn => { try { await fn(); return 'allowed'; } catch (error) { return error?.code ?? error?.message ?? 'denied'; } };
const evidence = {
  ambient: process.env.HOSTED_EXTENSION_TEST_SECRET,
  read: await denied(() => readFileSync(${JSON.stringify(sentinel)}, 'utf8')),
  write: await denied(() => writeFileSync(${JSON.stringify(escaped)}, 'escape')),
  child: await denied(() => { const result = spawnSync('/usr/bin/true'); if (result.error) throw result.error; }),
  network: await denied(() => fetch('https://example.com')),
};
export default flow('babysitter', async f => f.done('declined'))
  .on(github.pull_request('labeled'), async (f, input) => {
    evidence.run = await denied(() => f.run);
    evidence.github = await denied(() => f.github);
    evidence.mcp = await denied(() => f.mcp);
    evidence.agent = await denied(() => f.agent);
    if (evidence.ambient !== undefined
      || ['read', 'write', 'child', 'network'].some(key => evidence[key] === 'allowed')
      || ['run', 'github', 'mcp', 'agent'].some(key => !String(evidence[key]).startsWith('hosted extension context denies '))) {
      throw new Error('sandbox escape was allowed');
    }
    await f.capabilities.cloud.babysitterTurn.queue({ delivery: {
      deliveryId: input.event.deliveryId,
      provider: input.event.provider,
      eventType: input.event.eventType,
      pullRequest: { owner: input.pullRequest.owner, repository: input.pullRequest.repo, number: input.pullRequest.number },
    } });
    f.done('success');
  });
`;
    const installed = await artifact(source);
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    const original = process.env.HOSTED_EXTENSION_TEST_SECRET;
    process.env.HOSTED_EXTENSION_TEST_SECRET = 'host-secret-env';
    try {
      await runHostedCapabilityExtension({
        artifact: installed, dispatch, input: descriptor(),
        babysitterTurn: { queue: async () => ({ receiptId: 'receipt-1', status: 'queued' }) },
      });
    } finally {
      if (original === undefined) delete process.env.HOSTED_EXTENSION_TEST_SECRET;
      else process.env.HOSTED_EXTENSION_TEST_SECRET = original;
    }
    expect(() => readFileSync(escaped)).toThrow();
  });

  it('blocks extra handler fields and authority-bearing receipt fields at the parent port', async () => {
    const source = `
      import { flow, github } from '@relayflows/surface';
      export default flow('babysitter', async f => f.done('declined'))
        .on(github.pull_request('labeled'), async (f, input) => {
          await f.capabilities.cloud.babysitterTurn.queue({ delivery: input, sessionId: 'attacker' });
          f.done('success');
        });
    `;
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    let calls = 0;
    await expect(runHostedCapabilityExtension({
      artifact: await artifact(source), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => { calls += 1; return { receiptId: 'r', status: 'queued' }; } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(0);

    await expect(runHostedCapabilityExtension({
      artifact: await artifact(), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => ({ receiptId: 'r', status: 'queued', sessionId: 'host-leak' }) },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
  });

  it('refuses unbranded or mismatched authority before the capability adapter runs', async () => {
    const installed = await artifact();
    let calls = 0;
    const capability = { queue: async () => { calls += 1; return { receiptId: 'r', status: 'queued' }; } };
    await expect(runHostedCapabilityExtension({
      artifact: installed,
      dispatch: { provenance: 'integration-watch', provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1' } as never,
      input: descriptor(), babysitterTurn: capability,
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });

    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    await expect(runHostedCapabilityExtension({
      artifact: installed, dispatch, input: descriptor('attacker-delivery'), babysitterTurn: capability,
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
    await expect(runHostedCapabilityExtension({
      artifact: installed, dispatch,
      input: { ...descriptor(), rawWebhook: { installationToken: 'must-not-enter-child' } },
      babysitterTurn: capability,
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
    expect(calls).toBe(0);
  });

  it('refuses broader permissions before importing extension code', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'hosted-import-marker-')), 'imported');
    roots.push(marker.slice(0, marker.lastIndexOf('/')));
    const installed = await artifact(
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); ${ordinaryExtension}`,
      manifest(['cloud:babysitter-turn', 'github:pull_request']),
    );
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    await expect(runHostedCapabilityExtension({
      artifact: installed, dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => ({ receiptId: 'r', status: 'queued' }) },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(() => readFileSync(marker)).toThrow();
  });

  it('fails closed when the handler omits or repeats the single capability call', async () => {
    for (const body of [
      `f.done('success')`,
      `await f.capabilities.cloud.babysitterTurn.queue({ delivery: input }); await f.capabilities.cloud.babysitterTurn.queue({ delivery: input }); f.done('success')`,
    ]) {
      const installed = await artifact(`
        import { flow, github } from '@relayflows/surface';
        export default flow('babysitter', async f => f.done('declined'))
          .on(github.pull_request('labeled'), async (f, input) => { ${body}; });
      `);
      const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
        provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
      });
      await expect(runHostedCapabilityExtension({
        artifact: installed, dispatch, input: descriptor(),
        babysitterTurn: { queue: async () => ({ receiptId: 'r', status: 'queued' }) },
      })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    }
  });

  it('treats direct protocol output as hostile and rejects completion while the adapter is pending', async () => {
    const source = `
      import { writeSync } from 'node:fs';
      import { flow, github } from '@relayflows/surface';
      export default flow('babysitter', async f => f.done('declined'))
        .on(github.pull_request('labeled'), async (_f, input) => {
          writeSync(3, JSON.stringify({ type: 'capability', id: 1, name: 'cloud:babysitter-turn', request: { delivery: {
            deliveryId: input.event.deliveryId, provider: input.event.provider, eventType: input.event.eventType,
            pullRequest: { owner: input.pullRequest.owner, repository: input.pullRequest.repo, number: input.pullRequest.number },
          } } }) + '\\n');
          writeSync(3, JSON.stringify({ type: 'result', completionReason: 'success', capabilityCalls: 1 }) + '\\n');
          await new Promise(() => {});
        });
    `;
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    let resolveAdapter!: (value: unknown) => void;
    const adapter = new Promise(resolve => { resolveAdapter = resolve; });
    await expect(runHostedCapabilityExtension({
      artifact: await artifact(source), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => await adapter },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    resolveAdapter({ receiptId: 'too-late', status: 'queued' });

    const nonObject = `
      import { writeSync } from 'node:fs';
      import { flow, github } from '@relayflows/surface';
      writeSync(3, 'null\\n');
      export default flow('babysitter', async f => f.done('declined'))
        .on(github.pull_request('labeled'), async () => {});
    `;
    await expect(runHostedCapabilityExtension({
      artifact: await artifact(nonObject), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => ({ receiptId: 'never', status: 'queued' }) },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
  });
});
