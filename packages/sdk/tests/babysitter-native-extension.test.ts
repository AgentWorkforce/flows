import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Ctx } from '@relayflows/surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { loadAuthoredFlow } from '../src/authored-flow-loader.js';
import { exportBabysitterCatalogBundle } from '../src/babysitter-catalog-export.js';
import { addExtensionPlugin } from '../src/cli/add-extension.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/flow-extension-loader.js';
import { resolveExtensionSubmission } from '../src/flow-extension-submit.js';
import {
  loadHostedExtensionArtifacts,
  loadHostedExtensionBase,
  runHostedCapabilityExtension,
  selectHostedExtensionForRuntime,
} from '../src/hosted-extension-isolation.js';
import { JournalClient } from '../src/journal-client.js';
import { materializePlugin } from '../src/plugin-store.js';
import { preflightProviderTriggers } from '../src/provider-trigger-contract.js';
import { entriesFromDirectory, fakeGithub } from './fake-github.js';

const PATH = 'extensions/babysitter';
const NATIVE_SHA = 'd3ee3b55ae636518dd4ad562aca5bae9c99f1a05';
const REF = `github:AgentWorkforce/flows@${NATIVE_SHA}#${PATH}`;
const DIGEST = 'bdf2187b9a242667d34bbc63e7a744753e146dc8cd6f4047047f2aed28f406ee';
const MANIFEST_SHA256 = '5631a06bbdc8186f4ee0ff955610ead24d001c5197b59fb1fe81fe422c44f226';
// pull_request.labeled, .unlabeled and .ready_for_review route only in the surface after 2.0.25.
const versions = { sdk: '2.0.26', surface: '2.0.26' };
const now = () => new Date('2026-09-22T12:00:00Z');
const entries = entriesFromDirectory(resolve('../..', PATH), PATH);
const SUBSCRIPTIONS = [
  'pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened', 'pull_request.ready_for_review',
  'pull_request.closed', 'pull_request.labeled', 'pull_request.unlabeled',
  'pull_request_review.submitted', 'pull_request_review.dismissed', 'check_run.completed', 'issue_comment.created',
];
const HEAD = 'a'.repeat(40);
const dirs: string[] = [];
afterAll(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));

function github() {
  return fakeGithub({ 'AgentWorkforce/flows': { refs: {}, commits: { [NATIVE_SHA]: { entries } } } });
}

/** Install the committed bytes the way an operator would, then load the composition. */
async function composed() {
  const cwd = mkdtempSync(join(tmpdir(), 'babysitter-native-')); dirs.push(cwd);
  mkdirSync(join(cwd, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(cwd, 'node_modules/@relayflows/surface'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
  writeFileSync(join(cwd, 'flows.json'), JSON.stringify({ cli: 'codex', executors: ['github'] }));
  writeFileSync(join(cwd, 'software-factory.flow.ts'), `
    import { flow } from '@relayflows/surface';
    export default flow('software-factory', { budget: { dollars: 10, wallclock: '1h' } }, async f => { f.done('success'); });
  `);
  const io = { stdout: () => {}, stderr: (s: string) => { throw new Error(s); } };
  expect(await addExtensionPlugin(REF, io, { cwd, fetch: github().fetch, now, versions })).toBe(0);
  const loaded = await loadAuthoredFlow(join(cwd, 'software-factory.flow.ts'), { versions });
  const flowPath = join(cwd, 'software-factory.flow.ts');
  const baseLoaded = await loadAuthoredFlow(flowPath, { extensions: 'none', versions });
  const baseDefinition = baseLoaded.getDefinition(baseLoaded.handle);
  const hostedBase = await loadHostedExtensionBase(flowPath);
  return {
    cwd,
    flowPath,
    loaded,
    hostedBase,
    extension: loaded.extensions[0]!,
    base: { name: baseDefinition.name, version: baseDefinition.header.version },
  };
}

function subscriptionOf(trigger: unknown): string {
  const filter = (trigger as { filter: { type: string; payload?: { action?: string } } }).filter;
  return `${filter.type}.${filter.payload?.action}`;
}

function descriptor(eventType: string, pullRequest: Record<string, unknown> = {}) {
  return {
    event: { provider: 'github', eventType, deliveryId: 'gh-delivery-7' },
    pullRequest: { host: 'github', owner: 'AgentWorkforce', repo: 'flows', number: 551, headSha: HEAD, ...pullRequest },
  };
}

/** A context exposing only the declared write; any other capability is absent. */
function context(receipt: unknown = { receiptId: 'receipt-1', status: 'queued' }) {
  const requests: unknown[] = [];
  const done: string[] = [];
  const f = {
    capabilities: { cloud: { babysitterTurn: { queue: async (request: unknown) => { requests.push(request); return receipt; } } } },
    done: (reason: string) => { done.push(reason); },
  } as unknown as Ctx;
  return { f, requests, done };
}

// One install per file: every test reads the same composition, as one deployment would.
let installed: Awaited<ReturnType<typeof composed>>;
beforeAll(async () => { installed = await composed(); });

async function handle(eventType: string, input: unknown, f: Ctx) {
  const { extension } = installed;
  const handler = extension.handlers.find(h => subscriptionOf(h.trigger) === eventType)!;
  await handler.body(f, input);
}

describe('native Babysitter extension', () => {
  it('composes onto Software Factory with exactly the declared, deliverable subscriptions', async () => {
    const { loaded, extension } = installed;
    expect(extension.manifest.permissions).toEqual({
      integrations: ['github'], harnesses: ['codex'], mcp: [], writes: ['cloud:babysitter-turn'],
      budget: { dollars: 1, wallclock: '5m' },
    });
    expect(extension.manifest.extends).toEqual({ handlers: true, hooks: [] });
    expect(extension.handlers.map(h => subscriptionOf(h.trigger))).toEqual(SUBSCRIPTIONS);
    expect(preflightProviderTriggers(loaded.getDefinition(loaded.handle).handlers.map(h => h.trigger))).toEqual([]);
  });

  it('stays refused by hosted dispatch (#549) before either body runs', async () => {
    const { loaded } = installed;
    await expect(executeAuthoredFlow(loaded.handle, new JournalClient('/unused'), undefined, {
      getDefinition: loaded.getDefinition,
      extensions: loaded.extensions,
      extensionDispatch: hostedExtensionDispatchFromVerifiedDelivery({ provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'd-1' }),
    })).rejects.toMatchObject({ code: 'plugin_unsupported' });
  });

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'runs the exact published 2.0.26 native bytes in the isolated capability path', async () => {
    const installation = await loadHostedExtensionArtifacts(installed.flowPath);
    expect(installation.artifacts).toHaveLength(1);
    expect(installation.artifacts[0]).toMatchObject({ ref: REF, digest: DIGEST, manifestSha256: MANIFEST_SHA256 });
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'gh-delivery-7',
    });
    const calls: unknown[] = [];
    await expect(runHostedCapabilityExtension({
      installation,
      base: installed.hostedBase,
      dispatch,
      input: descriptor('pull_request.labeled'),
      babysitterTurn: { queue: async (request, authority) => {
        calls.push(request);
        expect(authority.dispatch).toBe(dispatch);
        expect(authority.extension).toEqual({
          name: 'babysitter', version: '0.2.0', ref: REF, digest: DIGEST,
        });
        return { receiptId: `bst_${'a'.repeat(64)}`, status: 'queued' };
      } },
    })).resolves.toEqual({ completionReason: 'success', capabilityCalls: 1 });
    expect(calls).toEqual([{ delivery: {
      deliveryId: 'gh-delivery-7', provider: 'github', eventType: 'pull_request.labeled',
      pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 551 },
    } }]);
  });

  it('refuses the real bytes on 2.0.25 before execution and admits them on 2.0.26', async () => {
    const installation = await loadHostedExtensionArtifacts(installed.flowPath);
    await expect(selectHostedExtensionForRuntime(
      installation, installed.base,
      { provider: 'github', event: 'pull_request', action: 'labeled' },
      { sdk: '2.0.25', surface: '2.0.25' },
    )).rejects.toMatchObject({ code: 'plugin_incompatible' });
    await expect(selectHostedExtensionForRuntime(
      installation, installed.base,
      { provider: 'github', event: 'pull_request', action: 'labeled' },
      versions,
    )).resolves.toMatchObject({ artifact: { ref: REF, digest: DIGEST } });
  });

  it('binds the pinned artifact to the actual base and complete installed route set', async () => {
    const installation = await loadHostedExtensionArtifacts(installed.flowPath);
    const dispatch = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'gh-delivery-7',
    });
    let calls = 0;
    await expect(runHostedCapabilityExtension({
      installation,
      base: installed.loaded as never,
      dispatch,
      input: descriptor('pull_request.labeled'),
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'never', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_incompatible' });
    expect(calls).toBe(0);

    await expect(runHostedCapabilityExtension({
      installation,
      base: installed.base as never,
      dispatch,
      input: descriptor('pull_request.labeled'),
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'never', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_incompatible' });
    expect(calls).toBe(0);

    await expect(runHostedCapabilityExtension({
      installation: { artifacts: installation.artifacts } as never,
      base: installed.hostedBase,
      dispatch,
      input: descriptor('pull_request.labeled'),
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'never', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_source_invalid' });
    expect(calls).toBe(0);

    const otherProject = await composed();
    await expect(runHostedCapabilityExtension({
      installation,
      base: otherProject.hostedBase,
      dispatch,
      input: descriptor('pull_request.labeled'),
      babysitterTurn: { queue: async () => {
        calls += 1;
        return { receiptId: 'never', status: 'queued' };
      } },
    })).rejects.toMatchObject({ code: 'plugin_source_invalid' });
    expect(calls).toBe(0);
  });

  it('refuses a second installed extension that overlaps an action-specific route', async () => {
    const overlapRef = `github:AgentWorkforce/other@${'b'.repeat(40)}#extensions/overlap`;
    const overlapManifest = {
      schema: 2, kind: 'flow-extension', name: 'overlap', version: '1.0.0',
      compat: { surface: '^2.0.26', sdk: '^2.0.26', base: [{ name: 'software-factory', version: '*' }] },
      entry: 'overlap.flow.ts', extends: { handlers: true, hooks: [] },
      triggers: [{ provider: 'github', event: 'pull_request', actions: [] }],
      permissions: { integrations: ['github'], harnesses: [], mcp: [], writes: [], budget: { dollars: 0.01, wallclock: '1m' } },
      preflight: { credentials: [], servers: [] },
    };
    const manifestBytes = Buffer.from(JSON.stringify(overlapManifest));
    const stored = await materializePlugin(installed.cwd, 'overlap', [
      { path: 'flows-plugin.json', data: manifestBytes },
      { path: 'overlap.flow.ts', data: Buffer.from('export default {};') },
    ]);
    const configPath = join(installed.cwd, 'flows.json');
    const lockPath = join(installed.cwd, 'flows.lock.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { plugins: string[] };
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version: 2; plugins: Array<Record<string, unknown>> };
    config.plugins.push(overlapRef);
    lock.plugins.push({
      name: 'overlap', kind: 'flow-extension', version: '1.0.0',
      source: { host: 'github', owner: 'AgentWorkforce', repo: 'other', sha: 'b'.repeat(40), path: 'extensions/overlap' },
      digest: stored.digest,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      order: 2,
      resolvedAt: '2026-09-22T12:00:00.000Z',
    });
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(lockPath, JSON.stringify(lock));

    const installation = await loadHostedExtensionArtifacts(installed.flowPath);
    await expect(selectHostedExtensionForRuntime(
      installation,
      installed.base,
      { provider: 'github', event: 'pull_request', action: 'labeled' },
      versions,
    )).rejects.toMatchObject({ code: 'plugin_event_ambiguous' });
  });

  it('satisfies the #550 catalog exporter from the committed bytes, manifest unmodified', async () => {
    const options = { fetch: github().fetch, versions };
    const bundle = await resolveExtensionSubmission(REF, options);
    const exported = await exportBabysitterCatalogBundle({ ref: REF, digest: bundle.digest, manifestSha256: bundle.manifestSha256 }, options);
    expect(exported.manifest).toEqual(JSON.parse(readFileSync(resolve('../..', PATH, 'flows-plugin.json'), 'utf8')));
    expect(exported.files.map(f => f.path).sort()).toEqual(['README.md', 'babysitter.flow.ts', 'flows-plugin.json', 'turn.ts']);
  });

  it('queues every subscription as exactly the delivery envelope: no findings, head, label, session, lineage, or config', async () => {
    for (const eventType of SUBSCRIPTIONS) {
      const c = context();
      await handle(eventType, descriptor(eventType), c.f);
      expect(c.requests).toEqual([{
        delivery: { deliveryId: 'gh-delivery-7', provider: 'github', eventType, pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 551 } },
      }]);
      expect(c.done).toEqual(['success']);
    }
  });

  it('accepts a descriptor without Cloud head enrichment or host', async () => {
    const c = context();
    await handle('pull_request.labeled', descriptor('pull_request.labeled', { headSha: undefined, host: undefined }), c.f);
    expect(c.requests).toEqual([{
      delivery: { deliveryId: 'gh-delivery-7', provider: 'github', eventType: 'pull_request.labeled', pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 551 } },
    }]);
  });

  it.each([
    ['a raw webhook', { action: 'labeled', pull_request: { number: 1 }, repository: { full_name: 'a/b' } }],
    ['an event for another subscription', descriptor('pull_request.opened')],
    ['a non-GitHub provider', { ...descriptor('pull_request.labeled'), event: { provider: 'gitlab', eventType: 'pull_request.labeled', deliveryId: 'd' } }],
    ['a caller-supplied session', { ...descriptor('pull_request.labeled'), sessionId: 's-1' }],
    ['a caller-supplied lineage on the PR', descriptor('pull_request.labeled', { lineageId: 'l-1' })],
    ['a missing delivery id', { ...descriptor('pull_request.labeled'), event: { provider: 'github', eventType: 'pull_request.labeled' } }],
    ['a malformed delivery id', { ...descriptor('pull_request.labeled'), event: { provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'a b' } }],
    ['a short head hint', descriptor('pull_request.labeled', { headSha: 'abc123' })],
    ['a non-integer PR number', descriptor('pull_request.labeled', { number: 1.5 })],
    ['a traversal repo name', descriptor('pull_request.labeled', { repo: '..' })],
    ['another host', descriptor('pull_request.labeled', { host: 'gitlab' })],
    ['no input', undefined],
  ])('refuses %s before requesting a turn', async (_case, input) => {
    const c = context();
    await expect(handle('pull_request.labeled', input, c.f)).rejects.toThrow(/^babysitter: /);
    expect(c.requests).toEqual([]);
    expect(c.done).toEqual([]);
  });

  it.each(['queued', 'duplicate'])('completes a %s receipt as success', async status => {
    const c = context({ receiptId: 'r-1', status });
    await handle('pull_request.synchronize', descriptor('pull_request.synchronize'), c.f);
    expect(c.done).toEqual(['success']);
  });

  it.each([
    null,
    'accepted',
    { status: 'queued' },
    { receiptId: 'r-1', status: 'refused' },
    { receiptId: 'r-1', status: 'queued', reason: 'label absent' },
    { receiptId: 'r-1', status: 'queued', sessionId: 's-1' },
  ])('fails the run on an unrecognized receipt %j', async receipt => {
    const c = context(receipt);
    await expect(handle('pull_request.labeled', descriptor('pull_request.labeled'), c.f)).rejects.toThrow(/^babysitter: /);
    expect(c.done).toEqual([]);
  });

  it.each([
    ['no capabilities (today\'s SDK context)', {}],
    ['no cloud capability', { capabilities: {} }],
    ['a queue that is not a function', { capabilities: { cloud: { babysitterTurn: { queue: 'x' } } } }],
  ])('fails closed on %s', async (_case, runtime) => {
    const f = { ...runtime, done: () => { throw new Error('must not complete'); } } as unknown as Ctx;
    await expect(handle('pull_request.labeled', descriptor('pull_request.labeled'), f))
      .rejects.toThrow('does not provide the cloud:babysitter-turn write');
  });

  it.each(['babysit label absent', 'relay native-turn 503 (in doubt)'])('fails the run once, without retry, when Cloud rejects: %s', async message => {
    let calls = 0;
    const f = {
      capabilities: { cloud: { babysitterTurn: { queue: async () => { calls += 1; throw new Error(message); } } } },
      done: () => { throw new Error('must not complete'); },
    } as unknown as Ctx;
    await expect(handle('pull_request.labeled', descriptor('pull_request.labeled'), f)).rejects.toThrow(message);
    expect(calls).toBe(1);
  });

  it('declines a direct run without requesting a turn', async () => {
    const { extension } = installed;
    const c = context();
    await extension.getDefinition(extension.handle).body(c.f, descriptor('pull_request.labeled'));
    expect(c.requests).toEqual([]);
    expect(c.done).toEqual(['declined']);
  });
});
import { createHash } from 'node:crypto';
