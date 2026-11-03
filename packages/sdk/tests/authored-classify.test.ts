import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flow, type ClassifyResult } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { AuthoredBudget } from '../src/authored-budget.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { authoredWorkerRunner } from '../src/authored-worker-step.js';
import { socketPathFor } from '../src/daemon-connection.js';

const root = resolve('../..');
const worktreeKey = execFileSync('cksum', { input: root, encoding: 'utf8' }).trim().split(' ')[0]!;
const binary = process.env.RELAYFLOWD_BIN ?? join(process.env.CARGO_TARGET_DIR
  ?? join(process.env.RELAYFLOWS_TOOLCHAIN_HOME ?? join(homedir(), '.relayflows-toolchain'), 'target', worktreeKey), 'debug/relayflowd');
const children: ChildProcess[] = [];
const clients: JournalClient[] = [];
const workers: LlmWorker[] = [];
const directories: string[] = [];
const options = { question: 'Choose depth', state: 'diff', options: { small: 'tiny', deep: 'sensitive' } };
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function start(directory?: string) {
  const dataDir = directory ?? mkdtempSync(join(tmpdir(), 'f-classify-'));
  if (directory === undefined) directories.push(dataDir);
  // Like the rest of the SDK integration suite, missing kernel is a failure.
  const child = spawn(binary, ['--data-dir', dataDir, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 500; attempt++) {
    const client = new JournalClient(socketPathFor(dataDir), { connectTimeoutMs: 100 });
    try {
      await client.connect(); await client.hello('classify-test'); clients.push(client);
      return { child, client, dataDir };
    } catch { client.close(); }
    if (child.exitCode !== null) throw new Error(stderr);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`daemon did not start: ${stderr}`);
}
async function attach(client: JournalClient, environment = { TYPESAFE_API_KEY: 'never-journal-this' }) {
  const peer = client.createPeer(); await peer.connect(); await peer.hello('classify-worker'); clients.push(peer);
  const worker = new LlmWorker(peer, 'classify-worker', 1, environment); workers.push(worker);
  worker.on('error', error => { throw error; }); await worker.attach(); return worker;
}
const response = () => new Response(JSON.stringify({ answers: { classification: { type: 'choice', choice: 'small', confidence: 0.9 } } }));

describe('authored Jev classification through the real journal', () => {
  it('branches on a recorded value, then replays after SIGKILL without HTTP or a credential', async () => {
    const fetch = vi.fn().mockImplementation(response); vi.stubGlobal('fetch', fetch);
    const first = await start(); const worker = await attach(first.client);
    const root = await first.client.runStart(toKernelSpec(compileSpec({ version: '0.1.0', name: 'root',
      steps: [{ id: 'root', type: 'agent', instruction: 'durable parent awaiting its body' }] })));
    let result: ClassifyResult | undefined;
    let gateCalls = 0;
    const handle = flow('classify', async f => {
      const mutable = { ...options, options: { ...options.options } };
      const step = f.classify(mutable);
      mutable.state = 'must not be sent'; mutable.options.small = 'changed';
      result = await step.gate(value => { gateCalls++; return value.choice === 'small'; });
      await f.run(result.choice === 'small' ? 'printf small' : 'exit 1');
      f.done('success');
    });
    const completed = await executeAuthoredFlow(handle, first.client, undefined, { dataDir: first.dataDir, rootRunId: root.run_id });
    expect(result).toEqual({ choice: 'small', confidence: 0.9, completionReason: 'success' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1].body).state).toBe('diff');
    const step = completed.journalSteps[0]!;
    const entries = (await first.client.journalRead(step.runId, 1)).entries;
    expect(JSON.stringify(entries)).not.toContain('never-journal-this');
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ entry_type: 'step.completed', payload:
      expect.objectContaining({ completionReason: 'success', output: result }) })]));
    await worker.close(); first.client.close();
    const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
    const second = await start(first.dataDir);
    fetch.mockImplementation(() => { throw new Error('must replay'); });
    const replay = await executeAuthoredFlow(handle, second.client, undefined, { dataDir: second.dataDir, rootRunId: root.run_id });
    expect(gateCalls).toBe(1);
    expect(replay.journalSteps.map(s => s.runId)).toEqual(completed.journalSteps.map(s => s.runId));
    expect(fetch).toHaveBeenCalledOnce();
  }, 15_000);
  it('enforces a named gate on the journaled choice', async () => {
    const { client, dataDir } = await start(); await attach(client);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(response));
    const handle = flow('named-classify', async f => {
      await f.classify(options).gate({ type: 'regex_match', pattern: '^deep$', in_output_at: ['choice'] });
      f.done('success');
    });
    await expect(executeAuthoredFlow(handle, client, undefined, { dataDir })).rejects.toMatchObject({ code: 'step_failed' });
  });
  it.each([
    [{}, undefined, 'worker_error', 'typesafe_api_key_missing'],
    [{}, 'deep', 'success', 'typesafe_api_key_missing'],
  ] as const)('journals missing-key failure or explicit fallback %#', async (environment, fallback, reason, diagnostic) => {
    const { client, dataDir } = await start(); await attach(client, environment as { TYPESAFE_API_KEY: string });
    const handle = flow('missing-key', async f => {
      const result = await f.classify({ ...options, ...(fallback === undefined ? {} : { fallback }) });
      expect(result).toMatchObject({ choice: 'deep', confidence: 0, fallbackReason: diagnostic });
      f.done('success');
    });
    let runId: string;
    if (fallback === undefined) {
      const failed = await executeAuthoredFlow(handle, client, undefined, { dataDir }).catch(error => error);
      expect(failed).toMatchObject({ code: 'step_failed' });
      runId = failed.runId;
    } else {
      const completed = await executeAuthoredFlow(handle, client, undefined, { dataDir });
      expect(completed.completionReason).toBe('success'); runId = completed.journalSteps[0]!.runId;
    }
    const entries = (await client.journalRead(runId, 1)).entries;
    expect(JSON.stringify(entries)).toContain(diagnostic);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ entry_type: 'step.completed',
      payload: expect.objectContaining({ completionReason: reason }) })]));
  });
  it('propagates a journal write failure without converting it to fallback', async () => {
    const { client } = await start(); await attach(client);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(response));
    const error = new Error('journal write failed');
    const original = JournalClient.prototype.stepComplete;
    vi.spyOn(JournalClient.prototype, 'stepComplete').mockImplementation(function(this: JournalClient, ...args) {
      if (args[1] === 'classify-1') return Promise.reject(error);
      return original.apply(this, args);
    });
    // Exercise the worker directly so the fatal event is captured, not thrown
    // across the process event loop while the root waits on its child lease.
    const worker = workers[0]!; worker.removeAllListeners('error');
    const failure = once(worker, 'error');
    const runner = authoredWorkerRunner({ name: 'write-failure' }, client, '', [], {}, undefined, new AuthoredBudget(undefined));
    const running = runner.classify('classify-1', { ...options, fallback: 'deep' });
    void running.catch(() => undefined);
    const [caught, dispatch] = await failure;
    expect(caught).toBe(error);
    // The unfinished journal is not a successful fallback completion.
    const entries = (await client.journalRead(dispatch.run_id, 1)).entries;
    expect(entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ entry_type: 'step.completed' })]));
    await client.runCancel(dispatch.run_id);
    await expect(running).rejects.toThrow();
    vi.restoreAllMocks();
  }, 15_000);
});
