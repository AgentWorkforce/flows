import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// @agent-relay/cloud@12.4.1: types.js AUTH_FILE_PATH / DEFAULT_REFRESH_TIMEOUT_MS;
// auth.js writeStoredAuth, AUTH_LOCK_*, requestStoredAuthRefresh. Keep together
// for contract updates. flows additionally honours AGENT_RELAY_HOME on writes.
const AUTH_DIRECTORY = '.agentworkforce/relay';
const AUTH_FILE = 'cloud-auth.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_RETRY_MS = 50;
// Interop constant: changing this can steal a live relay lock or delay recovery.
const LOCK_STALE_MS = 30_000;
const REFRESH_TIMEOUT_MS = 10_000;
const REFRESH_ROUTE = '/api/v1/auth/token/refresh';
// Deliberately shorter than relay's 30s acquire timeout for interactive reads.
const LOCK_ACQUIRE_MS = 5_000;

export interface AgentRelayCloudLogin extends Record<string, unknown> {
  apiUrl: string;
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export function agentRelayCloudAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['AGENT_RELAY_HOME'] ?? join(homedir(), AUTH_DIRECTORY), AUTH_FILE);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Explicit credentials bypass this store; expired fallback logins may be refreshed. */
export function readAgentRelayCloudLogin(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
): AgentRelayCloudLogin | undefined {
  try {
    const parsed: unknown = JSON.parse(read(agentRelayCloudAuthPath(env)));
    if (!record(parsed) || typeof parsed.apiUrl !== 'string' || typeof parsed.accessToken !== 'string'
      || !parsed.accessToken.trim()) return undefined;
    const login = { ...parsed } as AgentRelayCloudLogin;
    for (const key of ['accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt'] as const) {
      if (typeof parsed[key] !== 'string') delete login[key];
    }
    return login;
  } catch { return undefined; }
}

export function expiredCloudLogin(login: AgentRelayCloudLogin, now = Date.now()): boolean {
  const expiry = Date.parse(login.accessTokenExpiresAt ?? '');
  return Number.isFinite(expiry) && expiry <= now;
}

export function canRefreshCloudLogin(login: AgentRelayCloudLogin, now = Date.now()): boolean {
  return typeof login.refreshToken === 'string' && !!login.refreshToken.trim()
    && !(Date.parse(login.refreshTokenExpiresAt ?? '') <= now);
}

/** Shared transport policy; undefined lets the synchronous resolver keep its refusals. */
export function normalizeCloudBaseUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !/^\/[A-Za-z0-9/_-]*$/u.test(url.pathname)) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  } catch { return undefined; }
}

export type CloudLoginRefresh =
  | { kind: 'refreshed' | 'current' }
  | { kind: 'refused'; status?: number }
  | { kind: 'blocked' }
  | { kind: 'transport'; error: unknown }
  | { kind: 'unwritable'; error: unknown; path: string };

interface RefreshOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  refreshTimeoutMs?: number;
  lock?: { retryMs?: number; staleMs?: number; acquireTimeoutMs?: number };
}

async function writeLogin(path: string, login: AgentRelayCloudLogin): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(login, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
    await fs.chmod(temporaryPath, FILE_MODE);
    await fs.rename(temporaryPath, path);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function requestRefresh(login: AgentRelayCloudLogin, baseUrl: string, options: RefreshOptions): Promise<{ kind: 'ready'; login: AgentRelayCloudLogin } | CloudLoginRefresh> {
  const deadline = AbortSignal.timeout(Math.min(options.timeoutMs ?? REFRESH_TIMEOUT_MS,
    options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS));
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}${REFRESH_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }), redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    });
    if (!response.ok) return { kind: 'refused', status: response.status };
    const payload: unknown = await response.json();
    if (!record(payload) || typeof payload.accessToken !== 'string' || !payload.accessToken.trim()
      || /[\r\n]/u.test(payload.accessToken) || /^(?:rk|ot)_live_/u.test(payload.accessToken.trim())
      || typeof payload.refreshToken !== 'string' || !payload.refreshToken.trim()
      || typeof payload.accessTokenExpiresAt !== 'string'
      || !(Date.parse(payload.accessTokenExpiresAt) > (options.now ?? Date.now)())) return { kind: 'refused' };
    const apiUrl = typeof payload.apiUrl === 'string' && payload.apiUrl.trim() ? payload.apiUrl.trim() : login.apiUrl;
    const refreshTokenExpiresAt = typeof payload.refreshTokenExpiresAt === 'string' && payload.refreshTokenExpiresAt.trim()
      ? payload.refreshTokenExpiresAt.trim() : login.refreshTokenExpiresAt;
    if (normalizeCloudBaseUrl(apiUrl) !== baseUrl
      || (refreshTokenExpiresAt !== undefined && !Number.isFinite(Date.parse(refreshTokenExpiresAt)))) return { kind: 'refused' };
    return { kind: 'ready', login: { ...login, apiUrl, accessToken: payload.accessToken, refreshToken: payload.refreshToken,
      accessTokenExpiresAt: payload.accessTokenExpiresAt, refreshTokenExpiresAt } };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof SyntaxError && !deadline.aborted) return { kind: 'refused' };
    return { kind: 'transport', error: deadline.aborted ? deadline.reason : error };
  }
}

/** Serialize rotations with relay and re-source credentials after acquiring its lock. */
export async function refreshCloudLogin(
  login: AgentRelayCloudLogin, baseUrl: string, options: RefreshOptions = {},
): Promise<CloudLoginRefresh> {
  const path = agentRelayCloudAuthPath(options.env);
  const lockPath = `${path}.lock`;
  const now = options.now ?? Date.now;
  const started = now();
  const waitMs = Math.min(options.timeoutMs ?? LOCK_ACQUIRE_MS, options.lock?.acquireTimeoutMs ?? LOCK_ACQUIRE_MS);
  let acquired = false;
  try {
    options.signal?.throwIfAborted();
    await fs.mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    while (!acquired) {
      options.signal?.throwIfAborted();
      try {
        await fs.mkdir(lockPath, { mode: DIRECTORY_MODE });
        acquired = true;
      } catch (error) {
        if (!record(error) || error.code !== 'EEXIST') throw error;
        try {
          if (now() - (await fs.stat(lockPath)).mtimeMs > (options.lock?.staleMs ?? LOCK_STALE_MS)) {
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (error) {
          if (!record(error) || error.code !== 'ENOENT') throw error;
        }
        const remaining = waitMs - (now() - started);
        if (remaining <= 0) return { kind: 'blocked' };
        await delay(Math.min(options.lock?.retryMs ?? LOCK_RETRY_MS, remaining), undefined, { signal: options.signal });
      }
    }
    const latest = readAgentRelayCloudLogin(options.env);
    // A replaced/deleted login belongs to the other process; never overwrite it.
    if (!latest || latest.apiUrl !== login.apiUrl || !expiredCloudLogin(latest, now())) return { kind: 'current' };
    if (!canRefreshCloudLogin(latest, now())) return { kind: 'current' };
    const result = await requestRefresh(latest, baseUrl, options);
    if (result.kind !== 'ready') return result;
    await writeLogin(path, result.login);
    return { kind: 'refreshed' };
  } catch (error) {
    options.signal?.throwIfAborted();
    return { kind: 'unwritable', error, path };
  } finally {
    if (acquired) {
      try { await fs.rm(lockPath, { recursive: true, force: true }); }
      catch (error) { return { kind: 'unwritable', error, path }; }
    }
  }
}
