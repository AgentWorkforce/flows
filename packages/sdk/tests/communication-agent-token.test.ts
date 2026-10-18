import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  clients: [] as Array<Record<string, unknown>>,
  send: vi.fn(async (_agentToken: unknown, _input: unknown): Promise<unknown> => ({ id: 'm1' })),
}));
vi.mock('@agent-relay/harness-driver', () => ({ HarnessDriverClient: { spawn: mocks.spawn } }));
vi.mock('@agent-relay/sdk', () => ({
  RelaycastMessagingClient: class {
    agents = {}; channels = {};
    messages: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      mocks.clients.push(options);
      this.messages = { send: (input: unknown) => mocks.send(options.agentToken, input) };
    }
  },
}));
import { acquireRelayRuntime } from '../src/communication/relay.js';
import { runTokenAgents, runTokenProvider } from '../src/communication/run-token.js';
import { AgentTokenSession, rotationDelay } from '../src/communication/agent-token.js';

// Synthetic values; never real credentials.
const RUN_FIRST = 'rt_live_synthetic0first';
const RUN_SECOND = 'rt_live_synthetic0second';
const AGENT_FIRST = 'at_live_synthetic0agent1';
const AGENT_SECOND = 'at_live_synthetic0agent2';
const T0 = Date.parse('2026-10-17T12:00:00Z');
const MIN = 60_000;
const BASE = 'https://relaycast.test';

const dir = mkdtempSync(join(tmpdir(), 'flows-agent-token-'));
const runFile = join(dir, 'relaycast-run.json');
function writeRunFile(token: string) {
  const temp = `${runFile}.tmp`;
  writeFileSync(temp, JSON.stringify({ token, expiresAt: new Date(Date.now() + 15 * MIN).toISOString() }), { mode: 0o600 });
  renameSync(temp, runFile);
}
interface Call { method: string; path: string; authorization: string }
let calls: Call[];
type Responder = (call: Call) => Response | Promise<Response>;
function fakeFetch(responder: Responder) {
  calls = [];
  return vi.fn(async (url: string, init: RequestInit) => {
    const call = { method: init.method!, path: url.slice(BASE.length),
      authorization: (init.headers as Record<string, string>).authorization! };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
}
const ok = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });
const expiresIn = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeEach(() => { mocks.clients.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('rotation schedule', () => {
  it('rotates at two thirds of the lifetime or five minutes before expiry, whichever is earlier', () => {
    expect(rotationDelay(T0, T0 + 60 * MIN)).toBe(40 * MIN);
    expect(rotationDelay(T0, T0 + 15 * MIN)).toBe(10 * MIN);
    expect(rotationDelay(T0, T0 + 6 * MIN)).toBe(1 * MIN);
    expect(rotationDelay(T0, T0 + 3 * MIN)).toBe(0);
    expect(rotationDelay(T0, T0 - 1)).toBe(0);
  });

  it('rotates the agent token before it expires, authenticated by the agent itself', async () => {
    vi.useFakeTimers({ now: T0 });
    const doFetch = fakeFetch(() => ok({ token: AGENT_SECOND, token_expires_at: expiresIn(15 * MIN) }));
    const session = new AgentTokenSession('flow-journal',
      { token: AGENT_FIRST, tokenExpiresAt: new Date(T0 + 15 * MIN).toISOString() }, { baseUrl: BASE, fetch: doFetch });
    session.start();
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ method: 'POST', path: '/v1/agents/flow-journal/rotate-token', authorization: `Bearer ${AGENT_FIRST}` }]);
    expect(session.current()).toBe(AGENT_SECOND);
    // The next rotation follows the new token's expiry, still before it lapses.
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.authorization).toBe(`Bearer ${AGENT_SECOND}`);
    session.stop();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(calls).toHaveLength(2);
  });

  it('fails closed on a rejected rotation and retries transient failures', async () => {
    vi.useFakeTimers({ now: T0 });
    let status = 503;
    const doFetch = fakeFetch(() => Response.json({ ok: false, error: { code: 'x', message: 'x' } }, { status }));
    const session = new AgentTokenSession('a', { token: AGENT_FIRST, tokenExpiresAt: new Date(T0 + 15 * MIN).toISOString() },
      { baseUrl: BASE, fetch: doFetch });
    session.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls).toHaveLength(1);
    status = 401;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(calls).toHaveLength(2);
    expect(session.current()).toBe(AGENT_FIRST);
  });
});

describe('401 retry', () => {
  it('register retries once with a run token file rotated between attempts', async () => {
    writeRunFile(RUN_FIRST);
    const doFetch = fakeFetch(call => {
      if (call.authorization === `Bearer ${RUN_FIRST}`) {
        writeRunFile(RUN_SECOND); // Cloud rotated the file while the request was in flight.
        return Response.json({ ok: false, error: { code: 'unauthorized', message: 'expired' } }, { status: 401 });
      }
      return ok({ token: AGENT_FIRST, token_expires_at: expiresIn(15 * MIN) }, 201);
    });
    const agents = runTokenAgents(runTokenProvider(runFile), { baseUrl: BASE, fetch: doFetch });
    await expect(agents.register({ name: 'a', type: 'agent' })).resolves.toMatchObject({ token: AGENT_FIRST });
    expect(calls.map(call => call.authorization)).toEqual([`Bearer ${RUN_FIRST}`, `Bearer ${RUN_SECOND}`]);
  });

  it('retries only once', async () => {
    writeRunFile(RUN_FIRST);
    const doFetch = fakeFetch(() => Response.json({ ok: false, error: { code: 'unauthorized', message: 'x' } }, { status: 401 }));
    const agents = runTokenAgents(runTokenProvider(runFile), { baseUrl: BASE, fetch: doFetch });
    await expect(agents.delete('a')).rejects.toThrow('(401 unauthorized)');
    expect(calls).toHaveLength(2);
  });
});

describe('runtime messaging', () => {
  function stubRelaycast() {
    vi.stubGlobal('fetch', fakeFetch(call => {
      if (call.path.endsWith('/rotate-token')) return ok({ token: AGENT_SECOND, token_expires_at: expiresIn(15 * MIN) });
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return ok({ name: 'x', token: AGENT_FIRST, token_expires_at: expiresIn(15 * MIN), run_id: 'run-1' }, 201);
    }));
  }
  beforeEach(() => {
    mocks.spawn.mockResolvedValue({ spawnPty: vi.fn(), onEvent: vi.fn(), shutdown: vi.fn(async () => {}) });
    vi.stubEnv('RELAY_BASE_URL', BASE);
    vi.stubEnv('RELAYFLOW_RELAY_BROKER_BIN', undefined);
    writeRunFile(RUN_FIRST);
    vi.stubEnv('RELAY_RUN_TOKEN_FILE', runFile);
  });
  const message = { channel: 'wf-run', text: 'hi', idempotencyKey: 'k1', metadata: {} };

  it('uses the rotated agent token after a scheduled rotation', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    stubRelaycast();
    const runtime = await acquireRelayRuntime(dir, 'run-rotate');
    await runtime.messaging.messages.send(message);
    expect(mocks.send).toHaveBeenLastCalledWith(AGENT_FIRST, message);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls.at(-1)).toMatchObject({ path: `/v1/agents/${runtime.prefix}-journal/rotate-token`, authorization: `Bearer ${AGENT_FIRST}` });
    await runtime.messaging.messages.send(message);
    expect(mocks.send).toHaveBeenLastCalledWith(AGENT_SECOND, message);
    // Neither agent token ever reaches the broker.
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toMatch(/at_live_|rt_live_/);
    await runtime.close();
  });

  it('forces one rotation and retries when messaging gets a 401', async () => {
    stubRelaycast();
    const runtime = await acquireRelayRuntime(dir, 'run-401');
    mocks.send.mockImplementationOnce(async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); });
    await expect(runtime.messaging.messages.send(message)).resolves.toEqual({ id: 'm1' });
    expect(mocks.send.mock.calls.map(([token]) => token)).toEqual([AGENT_FIRST, AGENT_SECOND]);
    expect(calls.filter(call => call.path.endsWith('/rotate-token'))).toHaveLength(1);
    await runtime.close();
  });
});
