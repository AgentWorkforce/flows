import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flow } from '@relayflows/surface';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { resumeFlow } from '../src/cli/run.js';
import { runCli } from '../src/cli.js';
import { helperProviders, type HelperCall } from '@relayflows/surface/runtime';
import { WRITEBACK_PATH_CATALOG } from '@relayfile/adapter-core/writeback-paths';
import { runHelperEffect, resumeHelperEffect } from '../src/authored-helper-effect.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Match ops/cargo.sh's per-worktree build output for a plain `npm test` too.
const worktreeKey = spawnSync('cksum', { input: realpathSync(root), encoding: 'utf8' }).stdout.trim().split(' ')[0]!;
const target = process.env.CARGO_TARGET_DIR ?? join(process.env.RELAYFLOWS_TOOLCHAIN_HOME ?? join(homedir(), '.relayflows-toolchain'), 'target', worktreeKey);
const binary = process.env.RELAYFLOWD_BIN ?? join(target, 'debug/relayflowd');
const directories: string[] = [];
const children: ChildProcess[] = [];
const clients: JournalClient[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) await kill(child);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'f-helpers-'));
  directories.push(dir);
  return dir;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

async function start(dataDir: string): Promise<{ daemon: ChildProcess; client: JournalClient }> {
  expect(existsSync(binary), `Build relayflowd first: ${binary}`).toBe(true);
  const daemon = spawn(binary, ['--data-dir', dataDir, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(daemon);
  let stderr = '';
  daemon.stderr!.on('data', chunk => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new JournalClient(socketPathFor(dataDir), { connectTimeoutMs: 100 });
    try {
      await client.connect(); await client.hello('slack-test'); clients.push(client);
      return { daemon, client };
    } catch { client.close(); }
    if (daemon.exitCode !== null) throw new Error(stderr);
    await delay(20);
  }
  throw new Error(`Daemon did not start: ${stderr}`);
}

it('lowers the named acceptance helpers and Slack to confirmed journal effects', async () => {
  for (const p of helperProviders) vi.stubEnv(p.mockEnv, '1');
  const dataDir = temporary();
  const { client } = await start(dataDir);
  const result = await executeAuthoredFlow(flow('helper-smoke', async f => {
    const github = await f.github.createIssue({ repo: 'owner/repo', title: 'Smoke', body: 'body' });
    expect(github).toMatchObject({ status: 'confirmed' });
    await f.linear.createIssue({ teamId: 'team', title: 'Smoke' });
    await f.notion.appendBlock({ pageId: 'page', block: { type: 'paragraph' } });
    await f.stripe.createInvoice({ customer: 'cus_fixture' });
    await f.slack.post('#test', 'hello');
    f.done('success');
  }), client, undefined, { dataDir });
  expect(result.completionReason).toBe('success');
  expect(result.journalSteps).toHaveLength(6);
  for (const step of result.journalSteps.slice(0, -1)) {
    const entries = (await client.journalRead(step.runId, 1)).entries as any[];
    expect(entries.filter(e => e.entry_type === 'effect.confirmed')).toHaveLength(1);
    expect(entries.find(e => e.entry_type === 'step.completed').payload).toMatchObject({ completionReason: 'success', output: { type: 'effect' } });
  }
}, 30_000);

it('runs every available provider through the real kernel and resumes completed effects without a second write', async () => {
  const dataDir = temporary();
  const { client } = await start(dataDir);
  const catalog = WRITEBACK_PATH_CATALOG as Record<string, Record<string, readonly { path: string; params: readonly string[] }[]>>;
  for (const p of helperProviders.filter(p => p.supported && p.provider !== 'slack')) {
    vi.stubEnv(p.mockEnv, '1');
    const [resource, variants] = Object.entries(catalog[p.provider] ?? {})[0] ?? [];
    const params = Object.fromEntries((variants?.[0]?.params ?? []).map(param => [param, 'fixture']));
    const call: HelperCall = p.provider === 'stripe'
      ? { type: 'effect', provider: p.provider, verb: 'createInvoice', args: [{ customer: 'cus_fixture' }] }
      : { type: 'effect', provider: p.provider, verb: `${resource}.write`, args: [params, { text: 'smoke' }] };
    const steps: import('../src/authored-flow-executor.js').AuthoredFlowJournalStep[] = [];
    await runHelperEffect(client, 'fanout', p.provider, call, dataDir, steps);
    expect(steps).toHaveLength(1);
    const runId = steps[0]!.runId;
    expect(await resumeHelperEffect(client, runId, dataDir)).toBe(true);
    const entries = (await client.journalRead(runId, 1)).entries as any[];
    expect(entries.filter(e => e.entry_type === 'effect.confirmed'), p.provider).toHaveLength(1);
    expect(entries.filter(e => e.entry_type === 'step.completed'), p.provider).toHaveLength(1);
    expect(readdirSync(join(dataDir, 'mock-writeback', p.provider))).toEqual([`${p.provider}.json`]);
  }
}, 60_000);

it('rejects malformed arguments before a journal write, without evaluating getters', async () => {
  vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '1');
  let evaluated = false;
  const args = { repo: 'a/b', get title() { evaluated = true; return 'bad'; }, body: '' };
  const client = new JournalClient('/must-not-connect');
  await expect(executeAuthoredFlow(flow('bad-args', async f => {
    await f.github.createIssue(args); f.done('success');
  }), client)).rejects.toThrow('accessors');
  expect(evaluated).toBe(false);
});

function mockFiles(dataDir: string): string[] {
  return readdirSync(join(dataDir, "mock-writeback/github")).filter(file => file.endsWith(".json"));
}

  it.each(['confirm', 'complete'] as const)('replays after SIGKILL before %s with the same token and one successful completion', async boundary => {
    vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '1');
    const dataDir = temporary();
    const first = await start(dataDir);
    const script = join(dataDir, 'crash.mjs');
    writeFileSync(script, `
      import { flow } from ${JSON.stringify(join(root, 'packages/sdk/node_modules/@relayflows/surface/dist/index.js'))};
      import { JournalClient } from ${JSON.stringify(join(root, 'packages/sdk/dist/journal-client.js'))};
      import { executeAuthoredFlow } from ${JSON.stringify(join(root, 'packages/sdk/dist/authored-flow-executor.js'))};
      JournalClient.prototype.${boundary === 'confirm' ? 'effectConfirm' : 'stepComplete'} = async function() { process.stdout.write('CRASH_BOUNDARY\\n'); await new Promise(() => {}); };
      const client = new JournalClient(${JSON.stringify(socketPathFor(dataDir))});
      await client.connect(); await client.hello('crash-child');
      await executeAuthoredFlow(flow('crash-github', async f => { await f.github.createIssue({ repo: 'owner/repo', title: 'hi', body: '' }); f.done('success'); }), client, undefined, { dataDir: ${JSON.stringify(dataDir)} });
    `);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Did not reach crash window')), 10_000);
      child.stdout!.on('data', chunk => { if (String(chunk).includes('CRASH_BOUNDARY')) { clearTimeout(timer); resolve(); } });
      child.stderr!.on('data', chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
    });
    const file = join(dataDir, 'mock-writeback/github', mockFiles(dataDir)[0]!);
    const before = JSON.parse(readFileSync(file, 'utf8'));
    await kill(child); first.client.close(); await kill(first.daemon);
    const second = await start(dataDir);
    // Unconfirmed: lose the cache too to prove the provider token is stable.
    // Confirmed: the persisted receipt must suffice without another provider write.
    if (boundary === 'confirm') {
      for (const cache of readdirSync(join(dataDir, 'helper-receipts'))) rmSync(join(dataDir, 'helper-receipts', cache));
    }
    for (const key of ['GITHUB_BOT_TOKEN', 'RELAYFLOWS_GITHUB_MOCK', 'RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
    const refused = await resumeFlow(before.runId, dataDir, { daemon: { spawn: false } });
    expect(refused.exitCode).toBe(2);
    expect(refused.report.diagnostics).toContainEqual(expect.objectContaining({ kind: 'helper_provider.mount_required' }));
    vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '1');
    const resumed = await resumeFlow(before.runId, dataDir, { daemon: { spawn: false } });
    expect(resumed.exitCode, JSON.stringify(resumed.report)).toBe(0);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(after.receipt).toEqual(before.receipt);
    const entries = (await second.client.journalRead(before.runId, 1)).entries as any[];
    // The kernel records abandoned attempts as step.completed(crashed); one successful
    // completion is the exactly-once result, while retaining honest crash history.
    expect(entries.filter(entry => entry.entry_type === 'step.completed' && entry.payload.completionReason === 'success')).toHaveLength(1);
    expect(entries.filter(entry => entry.entry_type === 'step.completed' && entry.payload.completionReason === 'crashed')).toHaveLength(1);
    expect(entries.filter(entry => entry.entry_type === 'effect.recorded').length).toBeGreaterThan(1);
    const again = await resumeFlow(before.runId, dataDir, { daemon: { spawn: false } });
    expect(again.exitCode).toBe(0);
    expect(mockFiles(dataDir)).toHaveLength(1);
  }, 30_000);


it('journals provider failure with worker_error and never confirms the effect', async () => {
  vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '1');
  const dataDir = temporary(); const { client } = await start(dataDir);
  const steps: import('../src/authored-flow-executor.js').AuthoredFlowJournalStep[] = [];
  await expect(runHelperEffect(client, 'bad-helper', 'invalid', {
    type: 'effect', provider: 'github', verb: 'createIssue', args: [{ repo: 'missing-owner', title: 'hi', body: '' }],
  }, dataDir, steps)).rejects.toMatchObject({ code: 'step_failed', completionReason: 'worker_error' });
  expect(steps).toHaveLength(1);
  const entries = (await client.journalRead(steps[0]!.runId, 1)).entries as any[];
  expect(entries.filter(e => e.entry_type === 'effect.confirmed')).toHaveLength(0);
  expect(entries.find(e => e.entry_type === 'step.completed').payload.completionReason).toBe('worker_error');
});
