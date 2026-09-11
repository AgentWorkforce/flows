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
import { preflightHelpers } from '../src/preflight.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'f-slack-'));
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

function mockFiles(dataDir: string): string[] {
  return readdirSync(join(dataDir, 'mock-writeback/slack')).filter(file => file.endsWith('.json'));
}

describe('authored Slack helper effects', () => {
  it('snapshots structured posts into the journal and delivers the same Block Kit body', async () => {
    vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
    const dataDir = temporary();
    const { client } = await start(dataDir);
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Release*' } }];
    const attachments = [{ color: '#36a64f', fallback: 'Release', blocks }];
    const message = { text: 'Release', blocks, attachments };
    const expected = structuredClone(message);
    const result = await executeAuthoredFlow(flow('slack-block-kit', async f => {
      const post = f.slack.post('C1', message, { replyTo: 'parent-ref' });
      blocks[0]!.text.text = 'mutated after scheduling';
      attachments.push({ color: '#ff0000', fallback: 'later', blocks: [] });
      const receipt = await post.gate(value => Boolean(value.ts && value.ref));
      expect(receipt.channel).toBe('C1');
      f.done('success');
    }), client, undefined, { dataDir });
    const step = result.journalSteps[0]!;
    const entries = (await client.journalRead(step.runId, 1)).entries as any[];
    const completed = entries.filter(entry => entry.entry_type === 'step.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ payload: { completionReason: 'success', output: {
      params: { channel: 'C1', text: expected, opts: { replyTo: 'parent-ref' } },
    } } });
    expect(entries.filter(entry => entry.entry_type === 'effect.confirmed')).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(dataDir, 'mock-writeback/slack', `${step.id}.json`), 'utf8'));
    expect(written.request.body).toEqual({ ...expected, parentRef: 'parent-ref', idempotencyKey: `${step.runId}:${step.id}` });
  });

  it('journals exactly one effect with the authored params and typed receipt, without network', async () => {
    vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const dataDir = temporary();
    const { client } = await start(dataDir);
    const result = await executeAuthoredFlow(flow('slack-post', async f => {
      const receipt = await f.slack.post('#test', 'hi');
      expect(receipt).toMatchObject({ channel: '#test', ts: expect.stringMatching(/^mock-slack-/), ref: expect.stringMatching(/^mock-ref-/) });
      f.done('success');
    }), client, undefined, { dataDir });
    const step = result.journalSteps[0]!;
    const entries = (await client.journalRead(step.runId, 1)).entries as any[];
    const completed = entries.filter(entry => entry.entry_type === 'step.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ step_id: step.id, payload: { completionReason: 'success', output: {
      type: 'effect', provider: 'slack', verb: 'post', params: { channel: '#test', text: 'hi' },
      idempotencyKey: `${step.runId}:${step.id}`, receipt: { channel: '#test', ts: expect.any(String), ref: expect.any(String) },
    } } });
    expect(entries.filter(entry => entry.entry_type === 'effect.confirmed')).toHaveLength(1);
    expect(mockFiles(dataDir)).toEqual([`${step.id}.json`]);
    expect(network).not.toHaveBeenCalled();
  });

  it('refuses missing credentials before running the body and flows check exits 2', async () => {
    for (const key of ['SLACK_BOT_TOKEN', 'RELAYFLOWS_SLACK_MOCK', 'RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
    let executed = false;
    const handle = flow('no-credential', async f => { executed = true; await f.slack.post('#test', 'hi'); f.done('success'); });
    await expect(executeAuthoredFlow(handle, new JournalClient('/must-not-connect'))).rejects.toMatchObject({ code: 'helper_slack.credential_missing' });
    expect(executed).toBe(false);
    const dataDir = temporary();
    mkdirSync(join(dataDir, 'node_modules/@relayflows'), { recursive: true });
    symlinkSync(join(root, 'packages/sdk/node_modules/@relayflows/surface'), join(dataDir, 'node_modules/@relayflows/surface'));
    const fixture = join(dataDir, 'slack.mjs');
    writeFileSync(fixture, `import { flow } from ${JSON.stringify(join(root, 'packages/sdk/node_modules/@relayflows/surface/dist/index.js'))};\nexport default flow('slack', async f => { await f.slack.post('#test', 'hi'); f.done('success'); });`);
    const output: string[] = [];
    expect(await runCli(['check', '--json', fixture], { stdout: line => output.push(line), stderr: line => output.push(line) })).toBe(2);
    expect(output.join('')).toContain('helper_slack.credential_missing');
    vi.stubEnv('SLACK_BOT_TOKEN', 'configured-token');
    await expect(executeAuthoredFlow(handle, new JournalClient('/must-not-connect'))).rejects.toMatchObject({ code: 'helper_slack.mount_required' });
    expect(executed).toBe(false);
    expect(preflightHelpers({ header: {}, body: async (f: any) => f.slack.post('#test', 'hi') }, {
      slackMount: true, slackMock: false,
    }).ok).toBe(true);
  });

  it('surfaces helper_slack.credential_missing on `.flow.ts` paths too, not just helper modules', async () => {
    // Regression: `flows check` on `.flow.ts` routes through `checkAuthoredTriggers`
    // (trigger-aware) while `.mjs` helper modules routed through `checkHelperBody`.
    // Before this fix, the `.flow.ts` path silently skipped the helper preflight,
    // so a flow using `f.slack.post` without SLACK_BOT_TOKEN passed check and only
    // crashed at run.
    for (const key of ['SLACK_BOT_TOKEN', 'RELAYFLOWS_SLACK_MOCK', 'RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
    const dataDir = temporary();
    mkdirSync(join(dataDir, 'node_modules/@relayflows'), { recursive: true });
    symlinkSync(join(root, 'packages/sdk/node_modules/@relayflows/surface'), join(dataDir, 'node_modules/@relayflows/surface'));
    const fixture = join(dataDir, 'slack.flow.ts');
    writeFileSync(fixture, `import { flow } from ${JSON.stringify(join(root, 'packages/sdk/node_modules/@relayflows/surface/dist/index.js'))};\nexport default flow('slack-authored', async f => { await f.slack.post('#test', 'hi'); f.done('success'); });`);
    const output: string[] = [];
    expect(await runCli(['check', '--json', fixture], { stdout: line => output.push(line), stderr: line => output.push(line) })).toBe(2);
    expect(output.join('')).toContain('helper_slack.credential_missing');
  });

  it.each(['confirm', 'complete'] as const)('replays after SIGKILL before %s with the same token and one successful completion', async boundary => {
    vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
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
      await executeAuthoredFlow(flow('crash-slack', async f => { await f.slack.post('#test', 'hi'); f.done('success'); }), client, undefined, { dataDir: ${JSON.stringify(dataDir)} });
    `);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Did not reach crash window')), 10_000);
      child.stdout!.on('data', chunk => { if (String(chunk).includes('CRASH_BOUNDARY')) { clearTimeout(timer); resolve(); } });
      child.stderr!.on('data', chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
    });
    const file = join(dataDir, 'mock-writeback/slack', mockFiles(dataDir)[0]!);
    const before = JSON.parse(readFileSync(file, 'utf8'));
    await kill(child); first.client.close(); await kill(first.daemon);
    const second = await start(dataDir);
    // Unconfirmed: lose the cache too to prove the provider token is stable.
    // Confirmed: the persisted receipt must suffice without another provider write.
    if (boundary === 'confirm') {
      for (const cache of readdirSync(join(dataDir, 'helper-receipts'))) rmSync(join(dataDir, 'helper-receipts', cache));
    }
    for (const key of ['SLACK_BOT_TOKEN', 'RELAYFLOWS_SLACK_MOCK', 'RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
    const refused = await resumeFlow(before.runId, dataDir, { spawn: false });
    expect(refused.exitCode).toBe(2);
    expect(refused.report.diagnostics).toContainEqual(expect.objectContaining({ kind: 'helper_slack.credential_missing' }));
    vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
    const resumed = await resumeFlow(before.runId, dataDir, { spawn: false });
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
    const again = await resumeFlow(before.runId, dataDir, { spawn: false });
    expect(again.exitCode).toBe(0);
    expect(mockFiles(dataDir)).toHaveLength(1);
  }, 30_000);

  it('writes two files for two calls and supports dm, reply, and react', async () => {
    vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
    const dataDir = temporary();
    const { client } = await start(dataDir);
    await executeAuthoredFlow(flow('two-posts', async f => {
      await f.slack.post('#test', 'one'); await f.slack.post('#test', 'two'); f.done('success');
    }), client, undefined, { dataDir });
    const files = mockFiles(dataDir);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    await executeAuthoredFlow(flow('other-verbs', async f => {
      expect(await f.slack.dm('U123', 'hello')).toMatchObject({ user: 'U123', ts: expect.any(String) });
      expect(await f.slack.reply('#test', '123.456', 'reply')).toMatchObject({ channel: '#test', ts: expect.any(String) });
      expect(await f.slack.react('#test', '123.456', 'thumbsup')).toBeUndefined();
      f.done('success');
    }), client, undefined, { dataDir });
    const captures = mockFiles(dataDir).map(file => JSON.parse(readFileSync(join(dataDir, 'mock-writeback/slack', file), 'utf8')));
    expect(captures.find(call => call.verb === 'reply').request.body.thread_ts).toBe('123.456');
    expect(captures.find(call => call.verb === 'react').request.body).toMatchObject({ emoji: 'thumbsup', idempotencyKey: expect.any(String) });
  });
});
