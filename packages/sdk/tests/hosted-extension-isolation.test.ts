import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { github } from '@relayflows/surface';
import { extensionHandlerForHostedDispatch } from '../src/flow-extension-loader.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/index.js';
import {
  hostedManifestRoutes,
  loadHostedExtensionArtifacts,
  runVerifiedNativeExtensionSandbox,
  type HostedExtensionArtifact,
} from '../src/hosted-extension-isolation.js';
import { validateFlowExtensionManifest } from '../src/flow-extension-manifest.js';
import { supportsHostedSandboxFlags } from '../src/hosted-extension-sandbox.js';
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

function surfaceFixture(): string {
  const sourceRoot = resolve('../surface');
  const surfaceRoot = mkdtempSync(join(tmpdir(), 'hosted-surface-test-'));
  roots.push(surfaceRoot);
  writeFileSync(join(surfaceRoot, 'package.json'), JSON.stringify({
    name: '@relayflows/surface', version: '2.0.26', type: 'module',
  }));
  for (const file of [
    'flow.js', 'helpers/providers.js', 'provider-trigger.js',
    'schedule.js', 'triggers.js', 'triggers/github.js',
  ]) {
    const target = join(surfaceRoot, 'dist', file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    copyFileSync(join(sourceRoot, 'dist', file), target);
  }
  return surfaceRoot;
}

/** Emit raw parent-protocol frames during import, before any handler can run. */
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
    const flowPath = join(root, 'software-factory.flow.ts');
    writeFileSync(flowPath, 'export default {};');
    expect((await loadHostedExtensionArtifacts(flowPath)).artifacts).toEqual([installed]);
    expect(() => readFileSync(marker)).toThrow();
  });

  it.each(['queued', 'duplicate'] as const)('executes the exact capability-only handler for a %s receipt', async status => {
    const installed = await artifact();
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    const calls: unknown[] = [];
    const result = await runVerifiedNativeExtensionSandbox({
      artifact: installed, manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor(),
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

  it('mounts the verified snapshot when the live store is atomically replaced before bwrap', async () => {
    const installed = await artifact();
    const wrapperRoot = mkdtempSync(join(tmpdir(), 'hosted-bwrap-wrapper-'));
    roots.push(wrapperRoot);
    const wrapper = join(wrapperRoot, 'bwrap-wrapper');
    const replaced = `${installed.directory}.replaced`;
    const replacementSource = hostileImport([{ type: 'error', message: 'replacement executed' }]);
    writeFileSync(wrapper, `#!${process.execPath}
const { mkdirSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
renameSync(${JSON.stringify(installed.directory)}, ${JSON.stringify(replaced)});
mkdirSync(${JSON.stringify(installed.directory)}, { recursive: true });
writeFileSync(join(${JSON.stringify(installed.directory)}, 'babysitter.flow.ts'), ${JSON.stringify(replacementSource)});
const child = spawnSync('/usr/bin/bwrap', process.argv.slice(2), { stdio: [0, 1, 2, 3] });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`);
    chmodSync(wrapper, 0o700);
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: installed, manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor(),
      bubblewrapPath: wrapper, timeoutMs: 3_000,
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'receipt-1', status: 'queued' };
      } },
    })).resolves.toEqual({ completionReason: 'success', capabilityCalls: 1 });
    expect(calls).toBe(1);
    expect(readFileSync(join(installed.directory, 'babysitter.flow.ts'), 'utf8')).toBe(replacementSource);
  });

  it('mounts pinned private Surface bytes when the live package changes before launch', async () => {
    const surfaceRoot = surfaceFixture();
    const installed = await artifact();
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: installed,
      manifest: validateFlowExtensionManifest(manifest()),
      dispatch,
      input: descriptor(),
      surfaceRoot,
      beforeLaunch: async () => {
        writeFileSync(join(surfaceRoot, 'dist/flow.js'), `throw new Error('live Surface executed');\n`);
      },
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'receipt-1', status: 'queued' };
      } },
    })).resolves.toEqual({ completionReason: 'success', capabilityCalls: 1 });
    expect(calls).toBe(1);
    expect(readFileSync(join(surfaceRoot, 'dist/flow.js'), 'utf8')).toContain('live Surface executed');
  });

  it('refuses Surface runtime bytes that differ from the reviewed pin before launch', async () => {
    const surfaceRoot = surfaceFixture();
    writeFileSync(join(surfaceRoot, 'dist/flow.js'), `throw new Error('unreviewed Surface');\n`);
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(),
      manifest: validateFlowExtensionManifest(manifest()),
      dispatch,
      input: descriptor(),
      surfaceRoot,
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'receipt-1', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(calls).toBe(0);
  });

  it('preserves a typed host refusal while disclosing only a fixed marker to the child', async () => {
    const source = `
      import { flow, github } from '@relayflows/surface';
      export default flow('babysitter', async f => f.done('declined'))
        .on(github.pull_request('labeled'), async (f, input) => {
          try {
            await f.capabilities.cloud.babysitterTurn.queue({ delivery: {
              deliveryId: input.event.deliveryId, provider: input.event.provider, eventType: input.event.eventType,
              pullRequest: { owner: input.pullRequest.owner, repository: input.pullRequest.repo, number: input.pullRequest.number },
            } });
          } catch (error) {
            if (error?.message !== 'hosted capability refused') throw new Error('host refusal leaked into child');
            throw error;
          }
        });
    `;
    const refusal = Object.assign(new Error('private Cloud policy detail'), { code: 'cloud_policy_refusal' });
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(source), manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => { throw refusal; } },
    })).rejects.toBe(refusal);
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
      await runVerifiedNativeExtensionSandbox({
        artifact: installed, manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor(),
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
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(source), manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => { calls += 1; return { receiptId: 'r', status: 'queued' }; } },
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
    expect(calls).toBe(0);

    await expect(runVerifiedNativeExtensionSandbox({
      artifact: await artifact(), manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => ({ receiptId: 'r', status: 'queued', sessionId: 'host-leak' }) },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
  });

  it('refuses unbranded or mismatched authority before the capability adapter runs', async () => {
    const installed = await artifact();
    let calls = 0;
    const capability = { queue: async () => { calls += 1; return { receiptId: 'r', status: 'queued' }; } };
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: installed, manifest: validateFlowExtensionManifest(manifest()),
      dispatch: { provenance: 'integration-watch', provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1' } as never,
      input: descriptor(), babysitterTurn: capability,
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });

    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: installed, manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor('attacker-delivery'), babysitterTurn: capability,
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: installed, manifest: validateFlowExtensionManifest(manifest()), dispatch,
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
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: installed, manifest: validateFlowExtensionManifest(manifest(['cloud:babysitter-turn', 'github:pull_request'])), dispatch, input: descriptor(),
      babysitterTurn: { queue: async () => ({ receiptId: 'r', status: 'queued' }) },
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    expect(() => readFileSync(marker)).toThrow();
  });

  it('fails closed when the handler omits or repeats the single capability call', async () => {
    for (const body of [
      `f.done('success')`,
      `await f.capabilities.cloud.babysitterTurn.queue({ delivery: {
        deliveryId: input.event.deliveryId, provider: input.event.provider, eventType: input.event.eventType,
        pullRequest: { owner: input.pullRequest.owner, repository: input.pullRequest.repo, number: input.pullRequest.number },
      } })`,
      `const request = { delivery: {
        deliveryId: input.event.deliveryId, provider: input.event.provider, eventType: input.event.eventType,
        pullRequest: { owner: input.pullRequest.owner, repository: input.pullRequest.repo, number: input.pullRequest.number },
      } }; await f.capabilities.cloud.babysitterTurn.queue(request); await f.capabilities.cloud.babysitterTurn.queue(request); f.done('success')`,
    ]) {
      const installed = await artifact(`
        import { flow, github } from '@relayflows/surface';
        export default flow('babysitter', async f => f.done('declined'))
          .on(github.pull_request('labeled'), async (f, input) => { ${body}; });
      `);
      const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
        provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
      });
      await expect(runVerifiedNativeExtensionSandbox({
        artifact: installed, manifest: validateFlowExtensionManifest(manifest()), dispatch, input: descriptor(),
        babysitterTurn: { queue: async () => ({ receiptId: 'r', status: 'queued' }) },
      })).rejects.toMatchObject({ code: 'plugin_unsupported' });
    }
  });

  it('accepts only Node releases that implement every sandbox flag', () => {
    expect(supportsHostedSandboxFlags('22.12.0')).toBe(false);
    expect(supportsHostedSandboxFlags('22.13.0')).toBe(true);
    expect(supportsHostedSandboxFlags('23.4.0')).toBe(false);
    expect(supportsHostedSandboxFlags('23.5.0')).toBe(true);
    expect(supportsHostedSandboxFlags('24.0.0')).toBe(true);
    expect(supportsHostedSandboxFlags('not-a-version')).toBe(false);
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
});
