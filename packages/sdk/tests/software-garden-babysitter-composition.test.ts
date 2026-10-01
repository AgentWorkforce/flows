import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addExtensionPlugin } from '../src/cli/add-extension.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/flow-extension-loader.js';
import { runHostedSoftwareGardenBabysitter } from '../src/hosted-extension-isolation.js';
import { entriesFromDirectory, fakeGithub } from './fake-github.js';

const NATIVE_SHA = '8b33ebab8347514f80d9da5a81206a087f641714';
const REF = `github:AgentWorkforce/flows@${NATIVE_SHA}#extensions/babysitter`;
const DIGEST = 'bdf2187b9a242667d34bbc63e7a744753e146dc8cd6f4047047f2aed28f406ee';
const MANIFEST_SHA256 = '5631a06bbdc8186f4ee0ff955610ead24d001c5197b59fb1fe81fe422c44f226';
const entries = entriesFromDirectory(resolve('../..', 'extensions/babysitter'), 'extensions/babysitter');
const versions = { sdk: '2.0.33', surface: '2.0.33' };
const roots: string[] = [];

afterAll(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function github() {
  return fakeGithub({ 'AgentWorkforce/flows': { refs: {}, commits: { [NATIVE_SHA]: { entries } } } });
}

async function project(install = true) {
  const root = mkdtempSync(join(tmpdir(), 'software-garden-babysitter-'));
  roots.push(root);
  writeFileSync(join(root, 'software-factory.flow.ts'), readFileSync(resolve('../..', 'examples/software-factory/software-factory.flow.ts')));
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: 'codex', executors: ['github'] }));
  if (install) {
    const io = { stdout: () => {}, stderr: (message: string) => { throw new Error(message); } };
    expect(await addExtensionPlugin(REF, io, {
      cwd: root,
      fetch: github().fetch,
      now: () => new Date('2026-09-28T00:00:00Z'),
      versions,
    })).toBe(0);
  } else {
    writeFileSync(join(root, 'flows.lock.json'), JSON.stringify({ version: 2, plugins: [] }));
  }
  return { root, flowPath: join(root, 'software-factory.flow.ts') };
}

function dispatch(eventType = 'pull_request.labeled', deliveryId = 'delivery-1') {
  return hostedExtensionDispatchFromVerifiedDelivery({ provider: 'github', eventType, deliveryId });
}

function input(eventType = 'pull_request.labeled', deliveryId = 'delivery-1') {
  return {
    event: { provider: 'github', eventType, deliveryId },
    pullRequest: { host: 'github', owner: 'AgentWorkforce', repo: 'flows', number: 584, headSha: 'a'.repeat(40) },
  };
}

describe('canonical Software Garden + Babysitter composition', () => {
  let installed: Awaited<ReturnType<typeof project>>;
  beforeAll(async () => { installed = await project(); });

  it('installs the exact reviewed native artifact as the only composition member', () => {
    const lock = JSON.parse(readFileSync(join(installed.root, 'flows.lock.json'), 'utf8')) as {
      plugins: Array<{ source: { sha: string; path: string }; digest: string; manifestSha256: string }>;
    };
    expect(lock.plugins).toEqual([expect.objectContaining({
      source: expect.objectContaining({ sha: NATIVE_SHA, path: 'extensions/babysitter' }),
      digest: DIGEST,
      manifestSha256: MANIFEST_SHA256,
    })]);
  });

  it.runIf(process.platform === 'linux')('fails closed when the canonical Garden has no installed Babysitter artifact', async () => {
    const empty = await project(false);
    await expect(runHostedSoftwareGardenBabysitter({
      flowPath: empty.flowPath,
      dispatch: dispatch(),
      input: input(),
      babysitterTurn: { queue: async () => ({ receiptId: 'never', status: 'queued' }) },
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
  });

  it.runIf(process.platform === 'linux')('fails closed before the capability when the installed store digest drifts', async () => {
    const changed = await project();
    appendFileSync(join(changed.root, '.flows/plugins', `babysitter@sha256:${DIGEST}`, 'turn.ts'), '\n// drift\n');
    let calls = 0;
    await expect(runHostedSoftwareGardenBabysitter({
      flowPath: changed.flowPath,
      dispatch: dispatch(),
      input: input(),
      babysitterTurn: { queue: async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; } },
    })).rejects.toMatchObject({ code: 'plugin_source_drift' });
    expect(calls).toBe(0);
  });

  it.runIf(process.platform === 'linux')('fails closed before the capability when no reviewed handler owns the delivery', async () => {
    let calls = 0;
    await expect(runHostedSoftwareGardenBabysitter({
      flowPath: installed.flowPath,
      dispatch: dispatch('push'),
      input: input('push'),
      babysitterTurn: { queue: async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; } },
    })).rejects.toMatchObject({ code: 'plugin_event_unroutable' });
    expect(calls).toBe(0);
  });

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'executes the pinned composition and preserves queued/duplicate replay receipts', async () => {
      const statuses = ['queued', 'duplicate'] as const;
      const deliveryId = 'delivery-replay';
      const receiptId = `bst_${'1'.repeat(64)}`;
      const replayDispatch = dispatch('pull_request.labeled', deliveryId);
      const replayInput = input('pull_request.labeled', deliveryId);
      const calls: unknown[] = [];
      for (let index = 0; index < statuses.length; index += 1) {
        const result = await runHostedSoftwareGardenBabysitter({
          flowPath: installed.flowPath,
          dispatch: replayDispatch,
          input: replayInput,
          babysitterTurn: { queue: async (request, authority) => {
            calls.push({ request, authority });
            return { receiptId, status: statuses[index] };
          } },
        });
        expect(result).toEqual({ completionReason: 'success', capabilityCalls: 1 });
      }
      expect(calls).toHaveLength(2);
      expect(calls.map(call => (call as { request: { delivery: { deliveryId: string } } }).request.delivery.deliveryId))
        .toEqual([deliveryId, deliveryId]);
      expect(calls.map(call => (call as { authority: { dispatch: { deliveryId: string } } }).authority.dispatch.deliveryId))
        .toEqual([deliveryId, deliveryId]);
      expect(calls.map(call => (call as { authority: { extension: unknown } }).authority.extension)).toEqual([
        { name: 'babysitter', version: '0.2.0', ref: REF, digest: DIGEST, manifestSha256: MANIFEST_SHA256 },
        { name: 'babysitter', version: '0.2.0', ref: REF, digest: DIGEST, manifestSha256: MANIFEST_SHA256 },
      ]);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'propagates capability denial without a retry or fallback', async () => {
      const refusal = new Error('live babysit label is absent');
      let calls = 0;
      await expect(runHostedSoftwareGardenBabysitter({
        flowPath: installed.flowPath,
        dispatch: dispatch(),
        input: input(),
        babysitterTurn: { queue: async () => { calls += 1; throw refusal; } },
      })).rejects.toBe(refusal);
      expect(calls).toBe(1);
    },
  );
});
