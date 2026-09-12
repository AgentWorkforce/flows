import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { flow } from '@relayflows/surface';
import { createHelpers, helperProviders, type HelperCall } from '@relayflows/surface/runtime';
import { WRITEBACK_PATH_CATALOG } from '@relayfile/adapter-core/writeback-paths';
import * as vfs from '@relayfile/adapter-core/vfs-client';
import { helperWriteback } from '../src/helper-writeback.js';
import { checkProviderHelpers, providerMount } from '../src/slack-preflight.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';

vi.mock('@relayfile/adapter-core/vfs-client', async () => {
  const actual = await vi.importActual<typeof vfs>('@relayfile/adapter-core/vfs-client');
  return { ...actual, writeJsonFile: vi.fn() };
});

const dirs: string[] = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'helper-fanout-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const github: HelperCall = { type: 'effect', provider: 'github', verb: 'createIssue', args: [{ repo: 'owner/repo', title: 'hi', body: 'body' }] };

for (const provider of helperProviders) {
  it(`${provider.provider}: checks mount and its uniform mock variable`, () => {
    const dir = temporary();
    for (const key of ['RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
    vi.stubEnv(provider.mockEnv, '');
    const definition = { header: { tools: { [provider.namespace]: true } } };
    expect(checkProviderHelpers(definition).ok).toBe(false);
    vi.stubEnv(provider.mockEnv, '1');
    expect(checkProviderHelpers(definition).ok).toBe(provider.supported);
    vi.stubEnv(provider.mockEnv, '');
    vi.stubEnv('WORKSPACE_ROOT', dir);
    mkdirSync(join(dir, provider.provider));
    expect(providerMount(provider.provider)).toBe(dir);
    expect(checkProviderHelpers(definition).ok).toBe(provider.supported);
  });
  if (!provider.supported || provider.provider === 'slack') continue;
  it(`${provider.provider}: consumes its upstream client through the mock transport`, async () => {
    vi.stubEnv(provider.mockEnv, '1');
    const dir = temporary();
    const catalog = WRITEBACK_PATH_CATALOG as Record<string, Record<string, readonly { path: string; params: readonly string[] }[]>>;
    const [resource, variants] = Object.entries(catalog[provider.provider] ?? {})[0] ?? [];
    const params = Object.fromEntries((variants?.[0]?.params ?? []).map(param => [param, 'fixture']));
    const call: HelperCall = provider.provider === 'stripe'
      ? { type: 'effect', provider: 'stripe', verb: 'createInvoice', args: [{ customer: 'cus_fixture' }] }
      : { type: 'effect', provider: provider.provider, verb: `${resource}.write`, args: [params, { text: 'smoke' }] };
    await helperWriteback(call, dir, 'run', 'step', signal());
    const record = JSON.parse(readFileSync(join(dir, 'mock-writeback', provider.provider, 'step.json'), 'utf8'));
    expect(record.request.provider).toBe(provider.provider);
    expect(record.request.body.idempotencyKey).toBe('run:step');
    expect(record.receipt.externalId).toBe('mock-step');
  });
}

it('binds named verbs lazily with intact argument snapshots and synchronous paths', () => {
  const calls: HelperCall[] = [];
  const helpers = createHelpers(call => { calls.push(call); return {} as never; });
  const args = { repo: 'owner/repo', title: 'title', body: 'body' };
  helpers.github.createIssue(args);
  expect(calls).toEqual([{ type: 'effect', provider: 'github', verb: 'createIssue', args: [args] }]);
  expect(helpers.github.issues.path({ owner: 'owner', repo: 'repo' })).toBe('/github/repos/owner/repo/issues');
});

it('refuses body and bracket uses before any body or journal work', async () => {
  vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '');
  for (const key of ['RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
  let entered = false;
  const handle = flow('missing-github', async f => { entered = true; await f['github'].createIssue({ repo: 'a/b', title: 'x', body: '' }); f.done('success'); });
  await expect(executeAuthoredFlow(handle, new JournalClient('/must-not-connect'))).rejects.toMatchObject({ code: 'helper_provider.mount_required' });
  expect(entered).toBe(false);
});

it('preserves collection drafts, item paths, and confirmed receipts in mount mode', async () => {
  const dir = temporary(); mkdirSync(join(dir, 'github')); vi.stubEnv('RELAYFILE_MOUNT_PATH', dir); vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '');
  const write = vi.mocked(vfs.writeJsonFile).mockResolvedValue({ path: 'delivered', absolutePath: 'delivered', deliveryStatus: 'confirmed', receipt: { externalId: '123' } });
  await expect(helperWriteback(github, dir, 'run', 'issue', signal())).resolves.toMatchObject({ status: 'confirmed', id: '123' });
  expect(write.mock.calls[0]?.[3]).toMatch(/^\/github\/repos\/owner\/repo\/issues\/draft-[a-f0-9]+\.json$/);
  expect(write.mock.calls[0]?.[4]).toEqual({ title: 'hi', body: 'body', idempotencyKey: 'run:issue' });
  await helperWriteback({ ...github, verb: 'updateRef', args: [{ owner: 'owner', repo: 'repo', ref: 'branch', sha: '123' }] }, dir, 'run', 'ref', signal());
  expect(write.mock.calls[1]?.[3]).toMatch(/refs\/refs%2Fheads%2Fbranch\.json$/);
});

it('never confirms pending delivery or permits upstream created() to swallow a pending error', async () => {
  const dir = temporary(); mkdirSync(join(dir, 'github')); vi.stubEnv('RELAYFILE_MOUNT_PATH', dir); vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '');
  const write = vi.mocked(vfs.writeJsonFile).mockResolvedValue({ path: 'pending', absolutePath: 'pending', deliveryStatus: 'pending' });
  await expect(helperWriteback(github, dir, 'run', 'step', signal())).rejects.toThrow('pending');
  write.mockRejectedValue(new vfs.RelayfileWritebackPendingError({ provider: 'github', operation: 'write.issues', path: 'pending', opId: 'op', status: 'pending', timeoutMs: 1 }));
  await expect(helperWriteback(github, dir, 'run', 'step', signal())).rejects.toThrow();
});

it('blocks Notion append in mount mode and tests its lowering in mock mode', async () => {
  const dir = temporary(); mkdirSync(join(dir, 'notion')); vi.stubEnv('RELAYFILE_MOUNT_PATH', dir); vi.stubEnv('RELAYFLOWS_NOTION_MOCK', '');
  const call: HelperCall = { type: 'effect', provider: 'notion', verb: 'appendBlock', args: [{ pageId: 'page', block: { type: 'paragraph' } }] };
  await expect(helperWriteback(call, dir, 'run', 'step', signal())).rejects.toThrow('no upstream');
  vi.stubEnv('RELAYFLOWS_NOTION_MOCK', '1');
  await expect(helperWriteback(call, dir, 'run', 'step', signal())).resolves.toMatchObject({ status: 'confirmed' });
});

it('rejects cancellation and prototype method invocation', async () => {
  const dir = temporary(); vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '1');
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await expect(helperWriteback(github, dir, 'run', 'step', controller.signal)).rejects.toThrow('cancelled');
  await expect(helperWriteback({ ...github, verb: 'constructor' }, dir, 'run', 'step', signal())).rejects.toThrow('Unknown helper verb');
});

it('does not mistake memory.recall or unrelated object properties for helper namespaces', () => {
  const body = async (f: import('@relayflows/surface').Ctx) => { await f.memory.recall('query'); const item = { x: 1 }; return item.x; };
  expect(checkProviderHelpers({ body }).ok).toBe(true);
});
