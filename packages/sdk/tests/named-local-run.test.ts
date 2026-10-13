import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveNamedFlow } from '../src/cloud-flow-source.js';
import { loadAuthoredFlow } from '../src/authored-flow-loader.js';
import { runCli } from '../src/cli.js';
import type { RunExecution, RunLifecycleOptions } from '../src/cli/run.js';
import type { JournalEvent } from '../src/journal-reader.js';

const state = vi.hoisted(() => ({ cacheRoot: '', executed: [] as string[] }));
vi.mock('../src/cloud-flow-source.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/cloud-flow-source.js')>();
  return { ...original, resolveNamedFlow: (value: string, options = {}) =>
    original.resolveNamedFlow(value, { cacheRoot: state.cacheRoot, ...options }) };
});
vi.mock('../src/cli/subscription-report.js', () => ({
  withSubscriptionMetadata: async (execution: RunExecution) => execution,
}));
vi.mock('../src/cli/direct-run.js', () => ({
  runDirectFlow: async (path: string, _input: unknown, _directory: string, options: RunLifecycleOptions) => {
    state.executed.push(path);
    options.onRunStarted?.({ runId: 'local-root', flow: 'named-demo' });
    options.onProgress?.({ type: 'step.started', stepId: 'echo', stepType: 'deterministic' });
    options.onProgress?.({ type: 'step.completed', stepId: 'echo', stepType: 'deterministic', elapsedMs: 1 });
    return { exitCode: 0, report: { ok: true, command: 'run', runId: 'local-root',
      status: 'completed', completionReason: 'success', resolutions: [], diagnostics: [] } };
  },
}));
vi.mock('../src/journal-reader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/journal-reader.js')>(),
  walkJournal: async function* () {
    const entries = [
      { entry_type: 'run.spawned', payload: { spec: { name: 'named-demo', steps: [{ id: 'echo', type: 'deterministic', after: [] }] } } },
      { entry_type: 'step.attempt.started', step_id: 'echo', attempt: 1, payload: {} },
      { entry_type: 'step.completed', step_id: 'echo', attempt: 1, payload: { completionReason: 'success', disposition: 'step_done' } },
      { entry_type: 'run.completed', payload: { completionReason: 'success' } },
    ];
    for (const [seq, entry] of entries.entries()) yield {
      run_id: 'local-root', seq: seq + 1, segment_id: 1, at_ms: Date.now(), step_id: null, attempt: null, ...entry,
    } as JournalEvent;
  },
}));

const source = "import { flow } from '@relayflows/surface';\nexport default flow('named-demo', {}, async f => { f.done('success'); });\n";
const sha = createHash('sha256').update(source).digest('hex');
const flowId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const named = { flowId, listenerId: 'listener', name: 'named-demo', versionId, version: 1, sourceSha256: sha, fileType: 'ts', source };
type Request = { path: string; authorization?: string; body: any };
let requests: Request[];
let server: Server;
let directory: string;
let response: { status: number; body: unknown };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'named-local-run-'));
  state.cacheRoot = join(directory, 'cache');
  state.executed = [];
  requests = [];
  response = { status: 200, body: named };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { body = raw; }
    requests.push({ path: req.url!, authorization: req.headers.authorization, body });
    const answer = req.url!.includes('/by-name/') ? response : {
      status: 200, body: req.url!.endsWith('/local-run') ? {
        runId: 'cloud-run', accessToken: 'run-token', callbackToken: 'callback-token',
      } : req.url!.endsWith('/whoami') ? { currentWorkspace: { id: 'workspace' } }
        : req.url!.endsWith('/deploy') ? { agentId: 'manual-listener', status: 'manual' } : { ok: true },
    };
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit) => {
    const requested = new URL(String(url));
    return fetch(`http://127.0.0.1:${address.port}${requested.pathname}`, init);
  });
  vi.stubEnv('FLOWS_CLOUD_URL', 'https://fake-cloud.example');
  vi.stubEnv('FLOWS_CLOUD_TOKEN', 'operator-token');
  vi.stubEnv('AGENT_RELAY_HOME', directory);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  await rm(directory, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) } };
}

describe('named local flows against a fake HTTP server', () => {
  it('verifies and caches source with a loadable authoring runtime', async () => {
    const resolved = await resolveNamedFlow('named-demo');
    expect(resolved).toMatchObject({ flowId, flowVersionId: versionId });
    expect(resolved!.path).toBe(join(state.cacheRoot, 'named-demo', `${sha}.flow.ts`));
    expect(await readFile(resolved!.path, 'utf8')).toBe(source);
    const loaded = await loadAuthoredFlow(resolved!.path);
    expect(loaded.getDefinition(loaded.handle).name).toBe('named-demo');
  });

  it('preserves existing files, file-like arguments and digests without HTTP', async () => {
    const path = join(directory, 'named-demo');
    await writeFile(path, source);
    for (const value of [path, 'missing.flow.ts', './missing', '../missing', `demo@sha256:${sha}`]) {
      expect(await resolveNamedFlow(value)).toBeUndefined();
    }
    expect(requests).toEqual([]);
  });

  it('lets a bare local file win, but resolves a name shared by a directory', async () => {
    const name = `named-${randomUUID()}`;
    const local = join(process.cwd(), name);
    try {
      await writeFile(local, source, { flag: 'wx' });
      expect(await resolveNamedFlow(name)).toBeUndefined();
      expect(requests).toEqual([]);
      await rm(local);
      await mkdir(local);
      response.body = { ...named, name };
      expect(await resolveNamedFlow(name)).toMatchObject({ flowId, flowVersionId: versionId });
      expect(requests[0]!.path).toBe(`/api/v1/flows/by-name/${name}`);
    } finally { await rm(local, { recursive: true, force: true }); }
  });

  it('fails closed on source mismatch, corrupted cache and a missing name', async () => {
    response.body = { ...named, source: `${source}// changed` };
    await expect(resolveNamedFlow('named-demo')).rejects.toThrow('Source hash verification failed');
    response.body = named;
    const resolved = await resolveNamedFlow('named-demo');
    await writeFile(resolved!.path, 'tampered');
    await expect(resolveNamedFlow('named-demo')).rejects.toThrow('Cached source hash verification failed');
    response = { status: 404, body: { code: 'flow_not_found', error: 'Flow not found' } };
    const { io, out } = capture();
    expect(await runCli(['run', 'named-demo', '--json', '--no-observer-link'], io)).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ code: 'flow_not_found' });
    expect(state.executed).toEqual([]);
  });

  it('uses cloud login and reports named runs without a mirror flag, callback last', async () => {
    vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
    await writeFile(join(directory, 'cloud-auth.json'), JSON.stringify({
      apiUrl: 'https://fake-cloud.example', accessToken: 'login-token',
    }));
    const { io, out } = capture();
    expect(await runCli(['run', 'named-demo', '--input', '{"n":1}', '--json', '--no-observer-link', '--data-dir', directory], io)).toBe(0);
    expect(state.executed).toEqual([join(state.cacheRoot, 'named-demo', `${sha}.flow.ts`)]);
    const registration = requests.find(r => r.path.endsWith('/local-run'))!;
    expect(registration.authorization).toBe('Bearer login-token');
    expect(registration.body).toMatchObject({ workflow: source, flowId, flowVersionId: versionId, inputs: { n: 1 } });
    const reports = requests.slice(requests.indexOf(registration) + 1);
    expect(reports.every(r => r.authorization === 'Bearer run-token')).toBe(true);
    expect(reports.some(r => r.path.endsWith('/steps/snapshot') && r.body.steps.length === 1)).toBe(true);
    expect(reports.some(r => r.path.endsWith('/steps') && r.body.steps.length === 1)).toBe(true);
    expect(reports.filter(r => r.path.endsWith('/events'))).toHaveLength(2);
    expect(reports.at(-1)).toMatchObject({ path: '/api/v1/workflows/callback', body: { status: 'completed' } });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ cloudRunId: 'cloud-run' });
  });

  it('runs a saved name without input using an empty object', async () => {
    const { io } = capture();
    expect(await runCli(['run', 'named-demo', '--no-observer-link', '--data-dir', directory], io)).toBe(0);
    expect(requests.find(r => r.path.endsWith('/local-run'))!.body.inputs).toEqual({});
  });

  it('refuses malformed metadata before executing downloaded code', async () => {
    response.body = { ...named, fileType: 'yaml' };
    const { io } = capture();
    expect(await runCli(['run', 'named-demo', '--no-observer-link'], io)).toBe(2);
    expect(state.executed).toEqual([]);
  });

  it('reports file runs automatically and stays local with one note when signed out', async () => {
    const path = join(directory, 'demo.flow.ts');
    await writeFile(path, source);
    const args = ['run', path, '--input', '{}', '--json', '--no-observer-link', '--data-dir', directory];
    expect(await runCli(args, capture().io)).toBe(0);
    expect(requests.find(r => r.path.endsWith('/local-run'))!.body).not.toHaveProperty('flowId');
    requests = [];
    vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
    const { io, err } = capture();
    expect(await runCli(args, io)).toBe(0);
    expect(requests).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('Not signed in; this run stays local');
  });

  it('saves a manual flow without repo, approver or trigger and prints its run command', async () => {
    const resolved = await resolveNamedFlow('named-demo');
    requests = [];
    const { io, out } = capture();
    expect(await runCli(['deploy', resolved!.path], io)).toBe(0);
    const deploy = requests.find(r => r.path.endsWith('/deploy'))!;
    expect(deploy.body).toMatchObject({ name: 'named-demo', source, sources: [] });
    expect(deploy.body).not.toHaveProperty('repository');
    expect(deploy.body.inputs).not.toHaveProperty('approver');
    expect(out.join('\n')).toContain('flows run named-demo');
    expect(requests.map(r => r.path)).toEqual(['/api/v1/auth/whoami', '/api/v1/flows/deploy']);
  });
});
