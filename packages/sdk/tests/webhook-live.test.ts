import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { socketPathFor } from '../src/daemon-connection.js';
import { JournalClient } from '../src/journal-client.js';

const binary = process.env['RELAYFLOWD_BIN'] ?? resolve('../../kernel/target/debug/relayflowd');
const children: ChildProcess[] = [];
const directories: string[] = [];
const clients: JournalClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach(client => client.close());
  await Promise.all(children.splice(0).map(child => stop(child)));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => { child.once('exit', () => done()); child.kill('SIGKILL'); });
}
function start(command: string, args: string[]): { child: ChildProcess; output: () => string } {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stderr!.on('data', chunk => { output += String(chunk); });
  child.on('error', error => { output += error.message; });
  return { child, output: () => output };
}
async function until(predicate: () => boolean | Promise<boolean>, detail: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error(`webhook integration timed out: ${detail()}`);
}
async function daemon(dir: string): Promise<ChildProcess> {
  const process = start(binary, ['--data-dir', dir, 'serve']);
  await until(async () => {
    const client = new JournalClient(socketPathFor(dir), { requestTimeoutMs: 200 });
    try { await client.connect(); await client.hello('webhook-test'); return true; }
    catch { return false; } finally { client.close(); }
  }, process.output);
  return process.child;
}
async function setup(command = 'printf accepted'): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'flows-inbox-live-'));
  directories.push(dir);
  await mkdir(join(dir, 'triggers'));
  await writeFile(join(dir, 'triggers', 'release.json'), JSON.stringify({
    version: '0.1.0', name: 'release',
    triggers: [{ id: 'release', executor: 'release', event_type: 'release', dedupe_key_template: '{{event.type}}' }],
    steps: [{ id: 'log', type: 'deterministic', command }],
  }));
  const receiver = start(process.execPath, [resolve('dist/cli.js'), 'serve-webhook', '--data-dir', dir, '--port', '0']);
  await until(() => /WEBHOOK http:\/\/127.0.0.1:\d+/.test(receiver.output()), receiver.output);
  return { dir, base: receiver.output().match(/http:\/\/127.0.0.1:\d+/)![0] };
}
async function post(base: string): Promise<string> {
  const response = await fetch(`${base}/release`, { method: 'POST', body: JSON.stringify({ action: 'released', nested: [1, null] }) });
  expect(response.status).toBe(202);
  return `${(await response.json() as { id: string }).id}.json`;
}
async function journals(dir: string): Promise<string[]> {
  if (!existsSync(join(dir, 'runs'))) return [];
  return (await readdir(join(dir, 'runs'))).filter(file => file.endsWith('.sqlite3'));
}
async function readJournal(dir: string, runFile: string) {
  const client = new JournalClient(socketPathFor(dir));
  clients.push(client);
  await client.connect();
  return client.journalRead(runFile.slice(0, -8), 1);
}

it('flows serve-webhook writes JSON before the daemon starts, then journals and archives exactly once', async () => {
  const { dir, base } = await setup();
  const filename = await post(base);
  const inbox = join(dir, 'inbox/release', filename);
  expect(JSON.parse(await readFile(inbox, 'utf8'))).toEqual({ action: 'released', nested: [1, null] });
  expect(await journals(dir)).toEqual([]);
  await daemon(dir);
  const processed = join(dir, 'inbox-processed/release', filename);
  await until(() => existsSync(processed));
  const files = await journals(dir);
  expect(files).toHaveLength(1);
  const journal = await readJournal(dir, files[0]!);
  expect(journal.entries.find(entry => entry.entry_type === 'run.spawned')?.payload['event']).toEqual({ action: 'released', nested: [1, null] });
  expect(journal.entries.filter(entry => entry.entry_type === 'step.completed')).toHaveLength(1);
  await rename(processed, inbox);
  await until(() => existsSync(processed));
  expect(await journals(dir)).toEqual(files);
  expect((await readJournal(dir, files[0]!)).entries.filter(entry => entry.entry_type === 'step.completed')).toHaveLength(1);
}, 20_000);

it('replays a dropped file after SIGKILL before spawn', async () => {
  const { dir, base } = await setup();
  const first = await daemon(dir);
  first.kill('SIGSTOP');
  const filename = await post(base);
  expect(existsSync(join(dir, 'inbox/release', filename))).toBe(true);
  await stop(first);
  expect(await journals(dir)).toEqual([]);
  await daemon(dir);
  await until(() => existsSync(join(dir, 'inbox-processed/release', filename)));
  expect(await journals(dir)).toHaveLength(1);
}, 20_000);

it('resumes the same journal after SIGKILL after spawn and before acknowledgement', async () => {
  const { dir, base } = await setup('sleep 2; printf accepted');
  const first = await daemon(dir);
  const filename = await post(base);
  await until(async () => (await journals(dir)).length === 1);
  // Wait until a real attempt exists, proving the run is registered and driven.
  const files = await journals(dir);
  await until(async () => {
    const journal = await readJournal(dir, files[0]!);
    return journal.entries.some(entry => entry.entry_type === 'step.attempt.started');
  });
  clients.splice(0).forEach(client => client.close());
  await stop(first);
  expect(existsSync(join(dir, 'inbox/release', filename))).toBe(true);
  await daemon(dir);
  await until(() => existsSync(join(dir, 'inbox-processed/release', filename)));
  expect(await journals(dir)).toEqual(files);
  const journal = await readJournal(dir, files[0]!);
  expect(journal.entries.filter(entry => entry.entry_type === 'run.spawned')).toHaveLength(1);
  expect(journal.entries.some(entry => entry.entry_type === 'run.completed')).toBe(true);
}, 20_000);
