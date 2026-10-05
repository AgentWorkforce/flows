import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudFetch } from '../src/cloud-http.js';
import { refreshCloudLogin } from '../src/cloud-auth-store.js';
import { isTransientRead, refusalFor } from '../src/cli/cloud-refusal.js';

const apiUrl = 'https://login.example/cloud';
const old = { apiUrl, accessToken: 'old-access', accessTokenExpiresAt: '2020-01-01T00:00:00Z',
  refreshToken: 'old-refresh', refreshTokenExpiresAt: '2099-01-01T00:00:00Z' };
const rotated = { accessToken: 'new-access', accessTokenExpiresAt: '2098-01-01T00:00:00Z',
  refreshToken: 'new-refresh' };
let home: string;
let path: string;
const request = (options = {}) => cloudFetch('/resource', options, { method: 'GET' });
const write = (login: unknown) => fs.writeFile(path, JSON.stringify(login));
const bytes = () => fs.readFile(path, 'utf8');
function mockCloud(payload: unknown = rotated, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    new Response(JSON.stringify(String(url).endsWith('/token/refresh') ? payload : { ok: true }), { status }));
}
// @agent-relay/cloud@12.4.1 dist/auth.js:62-73 isValidStoredAuth.
function relayValid(value: Record<string, unknown>): boolean {
  return typeof value.accessToken === 'string' && typeof value.refreshToken === 'string'
    && typeof value.accessTokenExpiresAt === 'string' && typeof value.apiUrl === 'string'
    && (value.refreshTokenExpiresAt === undefined || typeof value.refreshTokenExpiresAt === 'string')
    && !Number.isNaN(Date.parse(value.accessTokenExpiresAt))
    && (value.refreshTokenExpiresAt === undefined || !Number.isNaN(Date.parse(value.refreshTokenExpiresAt as string)));
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'cloud-refresh-'));
  path = join(home, 'cloud-auth.json');
  vi.stubEnv('AGENT_RELAY_HOME', home);
  vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
  vi.stubEnv('FLOWS_CLOUD_URL', undefined);
  await write(old);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('cloud login refresh', () => {
  it('persists rotation atomically in relay format before proceeding, silently', async () => {
    await write({ ...old, futureKey: { keep: true } });
    const rename = vi.spyOn(fs, 'rename');
    const mkdir = vi.spyOn(fs, 'mkdir');
    const writeFile = vi.spyOn(fs, 'writeFile');
    const stdout = vi.spyOn(process.stdout, 'write');
    const fetch = mockCloud();
    fetch.mockImplementation(async url => {
      if (String(url).endsWith('/token/refresh')) return new Response(JSON.stringify(rotated));
      expect(JSON.parse(await bytes()).accessToken).toBe(rotated.accessToken);
      return new Response(JSON.stringify({ ok: true }));
    });
    await expect(request()).resolves.toEqual({ ok: true });
    expect(stdout).not.toHaveBeenCalled();
    const saved = JSON.parse(await bytes());
    expect(saved).toEqual({ ...old, ...rotated, futureKey: { keep: true } });
    expect(relayValid(saved)).toBe(true);
    expect(await bytes()).toBe(`${JSON.stringify(saved, null, 2)}\n`);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/\.cloud-auth\.json\..*\.tmp$/u), path);
    for (const [created] of [...mkdir.mock.calls, ...writeFile.mock.calls]) expect(String(created).startsWith(home)).toBe(true);
    expect(await fs.readdir(home)).toEqual(['cloud-auth.json']);
    expect(fetch.mock.calls[0]).toEqual([`${apiUrl}/api/v1/auth/token/refresh`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ refreshToken: old.refreshToken }), redirect: 'error',
      headers: { 'content-type': 'application/json' },
    })]);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer new-access' });
    await request();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { refreshToken: undefined }, { refreshToken: '' }, { refreshTokenExpiresAt: '2020-01-01' },
  ])('refuses unrefreshable logins without requests: %j', async patch => {
    await write({ ...old, ...patch });
    const before = await bytes();
    const fetch = mockCloud();
    await expect(request()).rejects.toMatchObject({ code: 'configuration', reason: 'auth_expired' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await bytes()).toBe(before);
  });

  it.each([400, 401, 403, 429, 503])('classifies HTTP %i without altering the store', async status => {
    const before = await bytes();
    mockCloud({ error: 'do not echo secret' }, status);
    const error = await request().catch(e => e);
    if ([400, 401, 403].includes(status)) {
      expect(error).toMatchObject({ code: 'configuration', reason: 'auth_expired' });
    } else {
      expect(error).toMatchObject({ code: 'http_error', status });
      expect(isTransientRead(error)).toBe(true);
      expect(error.message).not.toContain('has expired');
    }
    expect(error.message).not.toContain('secret');
    expect(await bytes()).toBe(before);
  });

  it.each([
    { ...rotated, refreshToken: undefined }, { ...rotated, accessTokenExpiresAt: 'invalid' },
    { ...rotated, accessToken: 'bad\ntoken' }, { ...rotated, refreshTokenExpiresAt: 'invalid' },
    ...['http://login.example/cloud', 'https://login.example/cloud?q=1', 'https://login.example/a.b',
      'https://other.example/cloud'].map(apiUrl => ({ ...rotated, apiUrl })),
  ])('rejects unusable payloads without persistence: %j', async payload => {
    const before = await bytes();
    mockCloud(payload);
    await expect(request()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await bytes()).toBe(before);
  });

  it.each(['token', 'env', 'empty-token', 'empty-env'])('explicit precedence bypasses all store operations: %s', async source => {
    const before = await bytes();
    const mkdir = vi.spyOn(fs, 'mkdir');
    const fetch = mockCloud();
    const empty = source.startsWith('empty');
    const token = empty ? '' : 'explicit';
    if (source.endsWith('env')) vi.stubEnv('FLOWS_CLOUD_TOKEN', token);
    else vi.stubEnv('FLOWS_CLOUD_TOKEN', 'lower-priority');
    const options = source.endsWith('env') ? {} : { token };
    if (empty) await expect(request(options)).rejects.toMatchObject({ reason: 'auth_missing' });
    else {
      await request(options);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer explicit' });
    }
    expect(mkdir).not.toHaveBeenCalled();
    expect(await bytes()).toBe(before);
  });

  it.each(['https://other.example/cloud', '', 'http://login.example/cloud'])('never refreshes mismatched or invalid target %s', async url => {
    vi.stubEnv('FLOWS_CLOUD_URL', url);
    const fetch = mockCloud();
    await expect(request()).rejects.toMatchObject({ reason: 'auth_expired' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, 2 ** 32])('validates timeout %s before refreshing', async requestTimeoutMs => {
    const before = await bytes();
    const fetch = mockCloud();
    await expect(request({ requestTimeoutMs })).rejects.toMatchObject({ reason: 'timeout_invalid' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await bytes()).toBe(before);
  });

  it.each([undefined, 'invalid', '2099-01-01'])('does not renew unexpired/unknown access expiry %s', async accessTokenExpiresAt => {
    await write({ ...old, accessTokenExpiresAt });
    const fetch = mockCloud();
    await request();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer old-access' });
  });

  it('lets the server decide an unparseable refresh expiry and persists a valid replacement', async () => {
    await write({ ...old, refreshTokenExpiresAt: 'invalid' });
    mockCloud({ ...rotated, refreshTokenExpiresAt: old.refreshTokenExpiresAt });
    await request();
    expect(relayValid(JSON.parse(await bytes()))).toBe(true);
  });

  it('collapses concurrent refreshes with a lock and re-read', async () => {
    const fetch = mockCloud();
    await Promise.all([request(), request()]);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/token/refresh'))).toHaveLength(1);
  });

  it('classifies lock contention as transient within the request timeout', async () => {
    await fs.mkdir(`${path}.lock`);
    const fetch = mockCloud();
    await expect(request({ requestTimeoutMs: 10 })).rejects.toMatchObject({ code: 'transient_error', message: expect.stringContaining('Another process') });
    expect(fetch).not.toHaveBeenCalled();
    expect(await fs.stat(`${path}.lock`)).toBeDefined();
  });

  it('removes stale locks using the relay stale window', async () => {
    await fs.mkdir(`${path}.lock`);
    await fs.utimes(`${path}.lock`, new Date(0), new Date(0));
    mockCloud();
    expect(await refreshCloudLogin(old, apiUrl, { lock: { retryMs: 1, acquireTimeoutMs: 10 } })).toEqual({ kind: 'refreshed' });
  });

  it('re-sources a newly rotated but still expired token after acquiring the lock', async () => {
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
      if (String(target) === `${path}.lock`) await write({ ...old, refreshToken: 'rotated-while-waiting' });
      return mkdir(target, options as Parameters<typeof fs.mkdir>[1]);
    });
    const fetch = mockCloud();
    await refreshCloudLogin(old, apiUrl);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ refreshToken: 'rotated-while-waiting' }));
  });

  it.each(['rename', 'mkdir'] as const)('classifies %s EACCES, never uses an unpersisted token', async operation => {
    const before = await bytes();
    vi.spyOn(fs, operation).mockRejectedValue(Object.assign(new Error('secret'), { code: 'EACCES' }));
    const fetch = mockCloud();
    const error = await request().catch(e => e);
    expect(error).toMatchObject({ code: 'configuration', reason: 'auth_store_unwritable' });
    expect(error.message).toContain(path);
    expect(error.message).toContain('EACCES');
    expect(error.message).not.toContain('secret');
    expect(refusalFor(error, 'login', {})).toMatchObject({ exit: 2 });
    expect(fetch).toHaveBeenCalledTimes(operation === 'rename' ? 1 : 0);
    expect(await bytes()).toBe(before);
    expect(await fs.readdir(home)).toEqual(['cloud-auth.json']);
  });

  it.each([
    [new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), 'transient_error'],
    [new TypeError('TLS failed'), 'transport_error'],
  ])('classifies transport errors without changing credentials', async (error, code) => {
    const before = await bytes();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    await expect(request()).rejects.toMatchObject({ code });
    expect(await bytes()).toBe(before);
  });

  it('bounds the refresh request with the refresh timeout', async () => {
    const before = await bytes();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const result = await refreshCloudLogin(old, apiUrl, { fetch, refreshTimeoutMs: 5 });
    expect(result).toMatchObject({ kind: 'transport', error: { name: 'TimeoutError' } });
    expect(await bytes()).toBe(before);
  });

  it('classifies a body timeout and malformed JSON without writing', async () => {
    const before = await bytes();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      }),
    } as Response));
    expect(await refreshCloudLogin(old, apiUrl, { fetch, refreshTimeoutMs: 5 }))
      .toMatchObject({ kind: 'transport', error: { name: 'TimeoutError' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not JSON'));
    await expect(request()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await bytes()).toBe(before);
  });

  it('propagates cancellation while waiting without removing the other process lock', async () => {
    await fs.mkdir(`${path}.lock`);
    const controller = new AbortController();
    const fetch = mockCloud();
    const promise = refreshCloudLogin(old, apiUrl, { signal: controller.signal, lock: { retryMs: 1 } });
    controller.abort(new Error('cancelled'));
    await expect(promise).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
    expect(await fs.stat(`${path}.lock`)).toBeDefined();
  });

});
