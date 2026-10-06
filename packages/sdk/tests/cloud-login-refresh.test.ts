import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudConnection, cloudFetch } from '../src/cloud-http.js';
import { runCloudLogsCli } from '../src/cli/cloud-read.js';

const baseUrl = 'https://login.example/cloud';
const past = '2020-01-01T00:00:00.000Z';
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const renewed = () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', accessTokenExpiresAt: future() });
let home: string;
let path: string;
let fetch: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
function store(overrides: Record<string, unknown> = {}) {
  const login = { apiUrl: baseUrl, accessToken: 'old-access', refreshToken: 'old-refresh',
    accessTokenExpiresAt: past, refreshTokenExpiresAt: future(), ...overrides };
  fs.writeFileSync(path, JSON.stringify(login));
  return login;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'cloud-login-refresh-'));
  path = join(home, 'cloud-auth.json');
  vi.stubEnv('AGENT_RELAY_HOME', home);
  vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
  vi.stubEnv('FLOWS_CLOUD_URL', undefined);
  fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
});
afterEach(() => {
  fs.chmodSync(home, 0o700);
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('cloud login refresh', () => {
  it('refreshes an expired access token and atomically persists the relay contract', async () => {
    const old = store();
    const payload = renewed();
    fetch.mockResolvedValue(Response.json(payload));
    expect(await cloudConnection({})).toEqual({ baseUrl, token: payload.accessToken });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/auth/token/refresh`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify({ refreshToken: old.refreshToken }) });
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    const written = JSON.parse(fs.readFileSync(path, 'utf8'));
    expect(written).toEqual({ ...old, ...payload });
    expect(Object.keys(written)).toHaveLength(5);
    expect(Number.isFinite(Date.parse(written.accessTokenExpiresAt))).toBe(true);
    expect(Number.isFinite(Date.parse(written.refreshTokenExpiresAt))).toBe(true);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home)).toEqual(['cloud-auth.json']);
    expect(fs.readFileSync(path, 'utf8')).not.toContain('old-refresh');
  });

  it.each([future(), undefined, 'not-a-date'])('does not refresh an access expiry of %s', async accessTokenExpiresAt => {
    store({ accessTokenExpiresAt });
    expect(await cloudConnection({})).toEqual({ baseUrl, token: 'old-access' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explicit credentials bypass the store, with the token option first', async () => {
    store();
    const read = vi.spyOn(fs, 'readFileSync');
    vi.stubEnv('FLOWS_CLOUD_TOKEN', 'env-token');
    expect(await cloudConnection({ token: 'option-token' })).toEqual({ baseUrl: 'https://agentrelay.com/cloud', token: 'option-token' });
    expect(await cloudConnection({})).toEqual({ baseUrl: 'https://agentrelay.com/cloud', token: 'env-token' });
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])('keeps the existing refusal for an absent/blank refresh token (%s)', async refreshToken => {
    store({ refreshToken });
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'auth_expired',
      message: 'The agent-relay cloud login has expired. Run `agent-relay cloud login` again, or set FLOWS_CLOUD_TOKEN.' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an expired refresh token without a request', async () => {
    store({ refreshTokenExpiresAt: past });
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'auth_expired', message: expect.stringContaining('and so has its refresh token') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'unknown'])('asks the server when refresh expiry is %s', async refreshTokenExpiresAt => {
    store({ refreshTokenExpiresAt });
    fetch.mockResolvedValue(Response.json({ ...renewed(), refreshTokenExpiresAt: future() }));
    expect((await cloudConnection({})).token).toBe('new-access');
  });

  it('refuses HTTP failure without leaking its body or modifying the store', async () => {
    store();
    const before = fs.readFileSync(path, 'utf8');
    fetch.mockResolvedValue(Response.json({ secret: 'never-echo-this' }, { status: 401 }));
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'auth_expired',
      message: 'The agent-relay cloud login has expired and could not be refreshed (HTTP 401). Run `agent-relay cloud login` again, or set FLOWS_CLOUD_TOKEN.' });
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(fs.readdirSync(home)).toEqual(['cloud-auth.json']);
  });

  it.each([
    { refreshToken: undefined }, { accessTokenExpiresAt: 42 }, { accessTokenExpiresAt: past },
    { accessToken: 'rk_live_secret' }, { accessToken: 'ot_live_secret' }, { accessToken: 'bad\nheader' },
    { accessToken: '' }, { refreshToken: '   ' },
  ])('rejects an invalid token set %j without persisting it', async overrides => {
    store();
    const before = fs.readFileSync(path, 'utf8');
    fetch.mockResolvedValue(Response.json({ ...renewed(), ...overrides }));
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'auth_expired', message: expect.stringContaining('not a valid token set') });
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses malformed JSON and transport errors without echoing secrets', async () => {
    store();
    fetch.mockResolvedValueOnce(new Response('secret malformed response'));
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'auth_expired', message: expect.stringContaining('not a valid token set') });
    fetch.mockRejectedValueOnce(new Error('secret transport detail'));
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'auth_expired',
      message: 'The agent-relay cloud login has expired and could not be refreshed (the refresh request failed). Run `agent-relay cloud login` again, or set FLOWS_CLOUD_TOKEN.' });
  });

  it.each(['https://other.example/cloud', 'http://login.example/cloud'])('validates the URL %s before refreshing', async apiUrl => {
    store();
    vi.stubEnv('FLOWS_CLOUD_URL', apiUrl);
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: apiUrl.startsWith('https:') ? 'url_mismatch' : 'url_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists a host-changing rotation but refuses to follow it', async () => {
    store();
    const apiUrl = 'https://new.example/cloud';
    fetch.mockResolvedValue(Response.json({ ...renewed(), apiUrl }));
    await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'url_mismatch',
      message: `The agent-relay cloud login was renewed for ${apiUrl}, not ${baseUrl}. Re-run the command, or set FLOWS_CLOUD_TOKEN for that deployment.` });
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toMatchObject({ apiUrl, refreshToken: 'new-refresh' });
    expect(await cloudConnection({})).toEqual({ baseUrl: apiUrl, token: 'new-access' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh across concurrent connections', async () => {
    store();
    const entered = deferred();
    const release = deferred();
    fetch.mockImplementation(async () => { entered.resolve(); await release.promise; return Response.json(renewed()); });
    const first = cloudConnection({});
    await entered.promise;
    const second = cloudConnection({});
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([{ baseUrl, token: 'new-access' }, { baseUrl, token: 'new-access' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recovers a stale relay lock', async () => {
    store();
    fs.mkdirSync(`${path}.lock`);
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(`${path}.lock`, stale, stale);
    fetch.mockResolvedValue(Response.json(renewed()));
    expect((await cloudConnection({})).token).toBe('new-access');
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
  });

  it('propagates cancellation while waiting on a fresh lock', async () => {
    store();
    fs.mkdirSync(`${path}.lock`);
    const signal = AbortSignal.timeout(100);
    await expect(cloudConnection({ signal })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(`${path}.lock`)).toBe(true);
  });

  it('propagates cancellation during refresh and releases the lock', async () => {
    store();
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    fetch.mockImplementation(async () => { controller.abort(reason); throw reason; });
    await expect(cloudConnection({ signal: controller.signal })).rejects.toBe(reason);
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('fails closed when the rotated login cannot be written', async () => {
    store();
    const before = fs.readFileSync(path, 'utf8');
    // Lock acquisition succeeds; the directory becomes unwritable during HTTP.
    fetch.mockImplementation(async () => {
      fs.chmodSync(home, 0o500);
      return Response.json(renewed());
    });
    try {
      await expect(cloudConnection({})).rejects.toMatchObject({ reason: 'auth_expired', message: expect.stringContaining('the login store could not be written') });
      expect(fs.readFileSync(path, 'utf8')).toBe(before);
    } finally { fs.chmodSync(home, 0o700); }
  });

  it('prints CLI logs after renewing an expired login', async () => {
    store();
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/auth/token/refresh')) return Response.json(renewed());
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-access');
      expect(String(input)).toContain('/api/v1/workflows/runs/run-1/logs');
      return Response.json({ content: 'renewed log\n', offset: 12, totalSize: 12, done: true });
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await runCloudLogsCli({ command: 'logs', runId: 'run-1', step: undefined, raw: false, json: false },
      { stdout: line => stdout.push(line), stderr: line => stderr.push(line) }, { env: {} })).toBe(0);
    expect(stdout.join('\n')).toContain('renewed log');
    expect(stderr).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses an invalid request timeout before spending a refresh token', async () => {
    store();
    await expect(cloudFetch('/test', { requestTimeoutMs: 0 }, { method: 'GET' })).rejects.toMatchObject({ reason: 'timeout_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
