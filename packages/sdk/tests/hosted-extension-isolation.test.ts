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
import { createServer } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/index.js';
import {
  loadHostedExtensionArtifacts,
  runVerifiedNativeExtensionSandbox,
  type HostedExtensionArtifact,
} from '../src/hosted-extension-isolation.js';
import { validateFlowExtensionManifest } from '../src/flow-extension-manifest.js';
import { materializePlugin } from '../src/plugin-store.js';

const roots: string[] = [];
const require = createRequire(import.meta.url);
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
  const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const surfaceRoot = mkdtempSync(join(tmpdir(), 'hosted-surface-test-'));
  roots.push(surfaceRoot);
  writeFileSync(join(surfaceRoot, 'package.json'), JSON.stringify({
    name: '@relayflows/surface', version: sourceManifest.version, type: 'module',
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

  it.runIf(process.platform === 'linux')(
    'launches through the captured process primitive after builtin export synchronization',
    async () => {
      const builtinChildProcess = require('node:child_process') as typeof import('node:child_process');
      const originalSpawn = builtinChildProcess.spawn;
      const originalExecPath = process.execPath;
      const installed = await artifact();
      const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
        provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
      });
      let poisonCalls = 0;
      try {
        Object.defineProperty(builtinChildProcess, 'spawn', {
          ...Object.getOwnPropertyDescriptor(builtinChildProcess, 'spawn'),
          value: (...args: unknown[]) => {
            const caller = (new Error().stack ?? '').split('\n', 4)[3] ?? '';
            if (caller.includes('/src/hosted-extension-sandbox.')) {
              poisonCalls += 1;
              throw new Error('ambient spawn must not run');
            }
            return Reflect.apply(originalSpawn, builtinChildProcess, args);
          },
        });
        syncBuiltinESMExports();
        process.execPath = '/attacker-controlled-node';
        await expect(runVerifiedNativeExtensionSandbox({
          artifact: installed,
          manifest: validateFlowExtensionManifest(manifest()),
          dispatch,
          input: descriptor(),
          babysitterTurn: { queue: async () => ({ receiptId: 'receipt-spawn', status: 'queued' }) },
        })).resolves.toEqual({ completionReason: 'success', capabilityCalls: 1 });
      } finally {
        process.execPath = originalExecPath;
        Object.defineProperty(builtinChildProcess, 'spawn', {
          ...Object.getOwnPropertyDescriptor(builtinChildProcess, 'spawn'), value: originalSpawn,
        });
        syncBuiltinESMExports();
      }
      expect(poisonCalls).toBe(0);
    },
  );

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
    const server = createServer((_request, response) => response.end('host-network-visible'));
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('host network fixture did not listen');
    const sentinel = join(mkdtempSync(join(tmpdir(), 'hosted-sentinel-')), 'secret.txt');
    roots.push(sentinel.slice(0, sentinel.lastIndexOf('/')));
    writeFileSync(sentinel, 'host-secret');
    const escaped = `${sentinel}.escaped`;
    const source = `
import { flow, github } from '@relayflows/surface';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
const denied = async fn => { try { await fn(); return 'allowed'; } catch (error) { return error?.code ?? error?.message ?? 'denied'; } };
const reachHostNetwork = () => new Promise((resolveNetwork, rejectNetwork) => {
  const socket = connect({ host: '127.0.0.1', port: ${address.port} });
  const timer = setTimeout(() => { socket.destroy(); rejectNetwork(new Error('network timeout')); }, 1000);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolveNetwork(); });
  socket.once('error', error => { clearTimeout(timer); rejectNetwork(error); });
});
const evidence = {
  ambient: process.env.HOSTED_EXTENSION_TEST_SECRET,
  read: await denied(() => readFileSync(${JSON.stringify(sentinel)}, 'utf8')),
  write: await denied(() => writeFileSync(${JSON.stringify(escaped)}, 'escape')),
  child: await denied(() => { const result = spawnSync('/usr/bin/true'); if (result.error) throw result.error; }),
  network: await denied(reachHostNetwork),
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
      server.close();
      if (original === undefined) delete process.env.HOSTED_EXTENSION_TEST_SECRET;
      else process.env.HOSTED_EXTENSION_TEST_SECRET = original;
    }
    expect(() => readFileSync(escaped)).toThrow();
  });

  it('enforces OS address-space and data bounds on native Buffer allocation', async () => {
    const installed = await artifact(`
      const allocations = [Buffer.alloc(2 * 1024 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024 * 1024)];
      if (allocations.some(allocation => allocation.byteLength !== 2 * 1024 * 1024 * 1024)) throw new Error('short allocation');
      ${ordinaryExtension}
    `);
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    let calls = 0;
    await expect(runVerifiedNativeExtensionSandbox({
      artifact: installed,
      manifest: validateFlowExtensionManifest(manifest()),
      dispatch,
      input: descriptor(),
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'receipt-1', status: 'queued' };
      } },
    })).rejects.toMatchObject({
      code: 'plugin_unsupported',
      message: expect.stringMatching(/(?:Failed to allocate memory|Array buffer allocation failed)/u),
    });
    expect(calls).toBe(0);
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

  it('constructs adapter authority with the captured freeze intrinsic', async () => {
    const installed = await artifact();
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-freeze',
    });
    const validatedManifest = validateFlowExtensionManifest(manifest());
    const originalFreeze = Object.freeze;
    let poisonCalls = 0;
    let result: Awaited<ReturnType<typeof runVerifiedNativeExtensionSandbox>> | undefined;
    try {
      Object.freeze = ((value: object) => {
        if ('dispatch' in value || ('ref' in value && 'digest' in value && 'version' in value)) {
          poisonCalls += 1;
          throw new Error('ambient authority freeze');
        }
        return originalFreeze(value);
      }) as typeof Object.freeze;
      result = await runVerifiedNativeExtensionSandbox({
        artifact: installed,
        manifest: validatedManifest,
        dispatch,
        input: descriptor('delivery-freeze'),
        babysitterTurn: { queue: async () => ({ receiptId: 'receipt-freeze', status: 'queued' }) },
        timeoutMs: 3_000,
      });
    } finally {
      Object.freeze = originalFreeze;
    }
    expect(poisonCalls).toBe(0);
    expect(result).toEqual({ completionReason: 'success', capabilityCalls: 1 });
  });

  it.runIf(process.platform === 'linux')(
    'writes the Surface manifest and protocol without inherited toJSON behavior',
    async () => {
      const installed = await artifact();
      const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
        provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-to-json',
      });
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
      let poisonCalls = 0;
      try {
        Object.defineProperty(Object.prototype, 'toJSON', {
          configurable: true,
          value: function poisonedToJSON(this: unknown) {
            const caller = (new Error().stack ?? '').split('\n', 4)[3] ?? '';
            if (caller.includes('/src/hosted-extension-')) {
              poisonCalls += 1;
              throw new Error('ambient Object.prototype.toJSON must not run');
            }
            return this;
          },
        });
        await expect(runVerifiedNativeExtensionSandbox({
          artifact: installed,
          manifest: validateFlowExtensionManifest(manifest()),
          dispatch,
          input: descriptor('delivery-to-json'),
          babysitterTurn: { queue: async () => ({ receiptId: 'receipt-to-json', status: 'queued' }) },
          timeoutMs: 3_000,
        })).resolves.toEqual({ completionReason: 'success', capabilityCalls: 1 });
      } finally {
        if (previous === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
        else Object.defineProperty(Object.prototype, 'toJSON', previous);
      }
      expect(poisonCalls).toBe(0);
    },
  );

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

});
