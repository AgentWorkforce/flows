import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { flow, webhook } from '@relayflows/surface';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN'] ?? join(
  process.env['CARGO_TARGET_DIR'] ?? join(homedir(), '.relayflows-toolchain', 'target', '1398563233'),
  'debug', 'relayflowd',
));
const daemons: ChildProcess[] = [];
const directories: string[] = [];
const clients: JournalClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      await new Promise<void>((resolveExit) => {
        daemon.once('exit', () => resolveExit());
        daemon.kill('SIGTERM');
      });
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('runs surface f.on through the local daemon event path and journals its buffered wake', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'flows-live-event-activity-'));
  directories.push(dataDir);
  await startDaemon(dataDir);
  const bodyClient = await client(dataDir);
  const routerClient = await client(dataDir);
  const root = await bodyClient.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: park
    type: agent
    instruction: park for activity
`)));

  const execution = executeAuthoredFlow(flow('surface-activity', async (f) => {
    const activity = f.on(webhook('github_pull_request'), { idle: '1h', deadline: '1d' });
    const wake = await activity.next();
    expect(wake).toEqual({
      kind: 'events', events: [{ type: 'github_pull_request', payload: { number: 42 } }], offset: 1,
    });
    f.done('success');
  }), bodyClient, undefined, { rootRunId: root.run_id });

  await waitFor(() => routerClient.journalRead(root.run_id, 1, 100).then(({ entries }) =>
    (entries as Array<{ entry_type?: string }>).some(entry => entry.entry_type === 'subscription.opened'),
  ));
  expect((await routerClient.eventEmit(
    root.run_id, 'github_pull_request', { number: 42 }, { delivery_id: 'live-event-42', actor: 'reviewer' },
  )).matched).toBe(1);
  await expect(execution).resolves.toMatchObject({ completionReason: 'success' });
  const entries = await routerClient.journalRead(root.run_id, 1, 100);
  expect((entries.entries as Array<{ entry_type?: string }>).map(entry => entry.entry_type)).toEqual(expect.arrayContaining([
    'subscription.opened', 'stream.appended', 'wait.completed', 'subscription.acknowledged', 'subscription.closed',
  ]));
}, 20_000);

it('survives SIGKILL after stream.appended and delivers the frame once after daemon restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'flows-live-event-restart-'));
  directories.push(dataDir);
  const firstDaemon = await startDaemon(dataDir);
  const before = await client(dataDir);
  const root = await before.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: park
    type: agent
    instruction: park for activity
`)));
  await before.subscriptionOpen({
    run_id: root.run_id, subscription_id: 'restart', event_types: ['github_pull_request'],
    settle_ms: 0, idle_ms: 60_000, deadline_ms: 86_400_000, include_self: false,
  });
  expect((await before.eventEmit(
    root.run_id, 'github_pull_request', { number: 99 }, { delivery_id: 'kill-window-99', actor: 'reviewer' },
  )).matched).toBe(1);
  await stop(firstDaemon, 'SIGKILL');
  const secondDaemon = await startDaemon(dataDir);
  expect(secondDaemon.exitCode).toBeNull();
  const after = await client(dataDir);
  await expect(after.subscriptionNext({ run_id: root.run_id, subscription_id: 'restart' })).resolves.toEqual({
    kind: 'events', events: [{ type: 'github_pull_request', payload: { number: 99 } }], offset: 1,
  });
  const entries = await after.journalRead(root.run_id, 1, 100);
  expect((entries.entries as Array<{ entry_type?: string }>).filter(entry => entry.entry_type === 'stream.appended')).toHaveLength(1);
}, 20_000);

async function startDaemon(dataDir: string): Promise<ChildProcess> {
  if (!existsSync(RELAYFLOWD)) throw new Error(`relayflowd binary is missing: ${RELAYFLOWD}`);
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], { stdio: 'ignore' });
  daemons.push(daemon);
  await waitFor(async () => {
    const socket = socketPathFor(dataDir);
    if (!existsSync(socket) || !lstatSync(socket).isSocket()) return false;
    const ready = new JournalClient(socket, { requestTimeoutMs: 250 });
    try {
      await ready.connect();
      await ready.hello('live-event-activity-readiness');
      return true;
    } catch {
      return false;
    } finally {
      ready.close();
    }
  });
  return daemon;
}

async function client(dataDir: string): Promise<JournalClient> {
  const connected = new JournalClient(socketPathFor(dataDir), { requestTimeoutMs: 5_000 });
  clients.push(connected);
  await connected.connect();
  await connected.hello('live-event-activities');
  return connected;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for local event activity');
}

async function stop(daemon: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    daemon.once('exit', () => resolveExit());
    daemon.kill(signal);
  });
}
