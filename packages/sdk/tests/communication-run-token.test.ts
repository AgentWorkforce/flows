import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  clients: [] as Array<Record<string, unknown>>,
  register: vi.fn(async () => ({ token: 'at_live_legacy' })),
  remove: vi.fn(async () => {}),
}));
vi.mock('@agent-relay/harness-driver', () => ({ HarnessDriverClient: { spawn: mocks.spawn } }));
vi.mock('@agent-relay/sdk', () => ({
  RelaycastMessagingClient: class {
    agents = { register: mocks.register, delete: mocks.remove };
    channels = {}; messages = {};
    constructor(options: Record<string, unknown>) { mocks.clients.push(options); }
  },
}));
import { acquireRelayRuntime } from '../src/communication/relay.js';
import { runTokenAgents } from '../src/communication/run-token.js';

// Synthetic values; never real credentials.
const FIRST = 'rt_live_synthetic0first';
const SECOND = 'rt_live_synthetic0second';
const dir = mkdtempSync(join(tmpdir(), 'flows-run-token-runtime-'));
const runFile = join(dir, 'relaycast-run.json');
const future = () => new Date(Date.now() + 600_000).toISOString();
function writeRunFile(token: string) {
  // Cloud's worker contract: write a 0600 temp file, then rename over the target.
  const temp = `${runFile}.tmp`;
  writeFileSync(temp, JSON.stringify({ token, expiresAt: future() }), { mode: 0o600 });
  renameSync(temp, runFile);
}
interface Call { method: string; url: string; authorization: string; body?: unknown }
let calls: Call[];
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method!, url, authorization: headers.authorization!,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ ok: true, data: { name: 'x', token: 'at_live_synthetic0agent', run_id: 'run-1' } }, { status: 201 });
  }));
}
const broker = { spawnPty: vi.fn(), onEvent: vi.fn(), shutdown: vi.fn(async () => {}) };

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.spawn.mockResolvedValue(broker);
  vi.stubEnv('RELAY_BASE_URL', 'https://relaycast.test');
  vi.stubEnv('RELAYFLOW_RELAY_BROKER_BIN', undefined);
  stubFetch();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('registers and deletes with the current file token and gives the broker only the path', async () => {
  writeRunFile(FIRST);
  vi.stubEnv('RELAY_API_KEY', 'rk_live_legacy0should0lose');
  vi.stubEnv('RELAY_RUN_TOKEN_FILE', runFile);
  const runtime = await acquireRelayRuntime(dir, 'run-1');

  expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://relaycast.test/v1/agents',
    authorization: `Bearer ${FIRST}`, body: { name: `${runtime.prefix}-journal`, type: 'agent' } });
  expect(mocks.register).not.toHaveBeenCalled();
  // The messaging client gets only the per-agent token, never a workspace key or run token.
  expect(mocks.clients).toEqual([{ baseUrl: 'https://relaycast.test', agentToken: 'at_live_synthetic0agent' }]);

  const spawnOptions = mocks.spawn.mock.calls[0]![0] as Record<string, unknown>;
  expect(spawnOptions.runTokenFile).toBe(runFile);
  expect(spawnOptions).not.toHaveProperty('workspaceKey');
  const serialized = JSON.stringify(spawnOptions);
  expect(serialized).not.toContain('rt_live_');
  expect(serialized).not.toContain('rk_live_');
  const env = spawnOptions.env as Record<string, string | undefined>;
  expect(Object.entries(env).filter(([, value]) => value !== undefined).map(([name]) => name))
    .not.toEqual(expect.arrayContaining(['RELAY_API_KEY', 'RELAY_RUN_TOKEN_FILE']));

  // Cloud rotates the file; the next call reads the new token.
  writeRunFile(SECOND);
  await runtime.close();
  expect(calls[1]).toMatchObject({ method: 'DELETE',
    url: `https://relaycast.test/v1/agents/${runtime.prefix}-journal`, authorization: `Bearer ${SECOND}` });
  // GET /v1/agents/:name does not accept run tokens and is never called.
  expect(calls.every(call => call.method !== 'GET')).toBe(true);
});

it('keeps the legacy workspace key path when no run token file is set', async () => {
  vi.stubEnv('RELAY_API_KEY', 'rk_live_legacy0key');
  vi.stubEnv('RELAY_RUN_TOKEN_FILE', undefined);
  const runtime = await acquireRelayRuntime(dir, 'run-2');
  expect(mocks.register).toHaveBeenCalledWith({ name: `${runtime.prefix}-journal`, type: 'agent' });
  expect(mocks.clients[0]).toEqual({ workspaceKey: 'rk_live_legacy0key', baseUrl: 'https://relaycast.test' });
  expect(mocks.spawn.mock.calls[0]![0]).toMatchObject({ workspaceKey: 'rk_live_legacy0key' });
  expect(mocks.spawn.mock.calls[0]![0]).not.toHaveProperty('runTokenFile');
  await runtime.close();
  expect(mocks.remove).toHaveBeenCalledWith(`${runtime.prefix}-journal`);
  expect(calls).toEqual([]);
});

it('surfaces envelope errors without the token value', async () => {
  writeRunFile(FIRST);
  const fetchImpl = vi.fn(async () => Response.json(
    { ok: false, error: { code: 'run_token_forbidden', message: `bad ${FIRST}` } }, { status: 401 }));
  const agents = runTokenAgents(async () => FIRST, { baseUrl: 'https://relaycast.test', fetch: fetchImpl as typeof fetch });
  const error = await agents.register({ name: 'a', type: 'agent' }).catch(e => e as Error);
  expect(error.message).toBe('Relaycast POST /v1/agents failed (401 run_token_forbidden).');
  expect(error.message).not.toContain('rt_live_');
});

it('refuses to register with an expired file and never sends a request', async () => {
  writeFileSync(runFile, JSON.stringify({ token: FIRST, expiresAt: '2020-01-01T00:00:00Z' }));
  vi.stubEnv('RELAY_RUN_TOKEN_FILE', runFile);
  await expect(acquireRelayRuntime(dir, 'run-3')).rejects.toThrow('expired');
  expect(calls).toEqual([]);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('never hands the run token file to communication agents', async () => {
  const { agentEnvironment } = await import('../src/communication/environment.js');
  expect(agentEnvironment('codex', { RELAY_RUN_TOKEN_FILE: runFile, OPENAI_API_KEY: 'codex-key' }))
    .toMatchObject({ RELAY_RUN_TOKEN_FILE: '', OPENAI_API_KEY: 'codex-key' });
});
