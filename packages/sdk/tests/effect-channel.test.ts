import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { channelPostSpec, completeChannelPost, type ChannelBroker } from '../src/effect-channel.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const root = resolve('../..');
const key = spawnSync('cksum', { input: realpathSync(root), encoding: 'utf8' }).stdout.trim().split(' ')[0]!;
const binary = process.env.RELAYFLOWD_BIN ?? join(process.env.CARGO_TARGET_DIR
  ?? join(process.env.RELAYFLOWS_TOOLCHAIN_HOME ?? join(homedir(), '.relayflows-toolchain'), 'target', key), 'debug/relayflowd');
const directories: string[] = [];
const children: ChildProcess[] = [];
const clients: JournalClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('lowers to an agent effect and refuses unresolved participants before submission', () => {
  const post = { channel: 'review-panel', to: 'security-lens', text: 'line 42' };
  expect(() => channelPostSpec('review', 'post', post, [])).toThrow('channel_participant_unresolved');
  expect(channelPostSpec('review', 'post', post, ['security-lens']).steps[0]).toMatchObject({
    type: 'agent', surfaces: { external: ['/channel/review-panel'] },
  });
  expect(() => channelPostSpec('review', 'post', { ...post, channel: '../escape' }, ['security-lens']))
    .toThrow('channel_invalid');
});

async function start(dir: string) {
  const daemon = spawn(binary, ['--data-dir', dir, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(daemon);
  let client: JournalClient | undefined;
  let stderr = '';
  daemon.stderr!.on('data', data => { stderr += String(data); });
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = new JournalClient(socketPathFor(dir), { connectTimeoutMs: 100 });
    try { await candidate.connect(); await candidate.hello('channel-test'); client = candidate; break; }
    catch { candidate.close(); await delay(20); }
  }
  if (!client) throw new Error(`daemon startup failed: ${stderr}`);
  clients.push(client);
  const worker = client.createPeer(); clients.push(worker);
  await worker.connect(); await worker.hello('channel-worker');
  const dispatched = once(worker, 'step.dispatch') as Promise<[StepDispatchEvent]>;
  await worker.workerAttach('channel-worker', ['agent'], {
    workspace: [], streams: [{ stream: 'channel-review-panel', read_offset: 0 }],
  }, 1);
  return { daemon, client, worker, dispatched };
}

it.each(['none', 'record', 'confirm', 'complete'] as const)('journals one post across interruption before %s', async boundary => {
  expect(existsSync(binary), `Build relayflowd first: ${binary}`).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'channel-effect-')); directories.push(dir);
  let active = await start(dir);
  const spec = channelPostSpec('review', 'post', {
    channel: 'review-panel', to: 'security-lens', text: 'this looks off at line 42',
  }, ['security-lens']);
  const run = await active.client.runStart(spec);
  let [dispatch] = await active.dispatched;
  const delivered = new Map<string, unknown>();
  const dm = vi.fn(async (input: Parameters<ChannelBroker['messages']['dm']>[0]) => {
    if (!delivered.has(input.idempotencyKey)) delivered.set(input.idempotencyKey, input);
    return { credential: 'must-not-leak', providerId: 'provider-record' };
  });
  const broker = { messages: { dm } };
  if (boundary !== 'none') {
    vi.spyOn(active.worker, boundary === 'record' ? 'effectRecord' : boundary === 'confirm' ? 'effectConfirm' : 'stepComplete')
      .mockRejectedValueOnce(new Error('injected interruption'));
    await expect(completeChannelPost(active.worker, dispatch, broker, ['security-lens']))
      .rejects.toThrow('injected interruption');
    if (boundary === 'record') expect(dm).not.toHaveBeenCalled();
    active.worker.close(); active.client.close();
    const exited = once(active.daemon, 'exit'); active.daemon.kill('SIGKILL'); await exited;
    active = await start(dir);
    await active.client.runResume(run.run_id);
    [dispatch] = await active.dispatched;
    expect(dispatch.attempt).toBe(2);
  }
  await completeChannelPost(active.worker, dispatch, broker, ['security-lens']);
  expect(delivered.size).toBe(1);
  expect(dm).toHaveBeenCalledTimes(boundary === 'confirm' ? 2 : 1);
  if (boundary === 'confirm') expect(dm.mock.calls[0]).toEqual(dm.mock.calls[1]);
  const entries = (await active.client.journalRead(run.run_id, 1)).entries as Array<{
    entry_type: string; payload: { output?: { messageId: string }; completionReason?: string };
  }>;
  expect(entries.filter(e => e.entry_type === 'effect.confirmed')).toHaveLength(1);
  const completed = entries.filter(e => e.entry_type === 'step.completed' && e.payload.completionReason === 'success');
  expect(completed).toHaveLength(1);
  expect(completed[0]!.payload.completionReason).toBe('success');
  expect(completed[0]!.payload.output!.messageId).toBe([...delivered.keys()][0]);
  expect(JSON.stringify(entries)).not.toContain('must-not-leak');
}, 15_000);
