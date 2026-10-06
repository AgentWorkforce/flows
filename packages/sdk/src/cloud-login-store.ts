import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Shares relay CLI's directory lock and canonical file shape. Credential
 * resolution can wait ~30 s for the lock plus 10 s for refresh, independently
 * of requestTimeoutMs. Unlike relay, persist a host-changing rotation before
 * the caller refuses it: discarding it could lose a single-use refresh token.
 */
export interface AgentRelayCloudLogin {
  apiUrl: string;
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export function agentRelayCloudAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['AGENT_RELAY_HOME'] ?? join(homedir(), '.agentworkforce/relay'), 'cloud-auth.json');
}

export function readAgentRelayCloudLogin(env: NodeJS.ProcessEnv = process.env): AgentRelayCloudLogin | undefined {
  try {
    const value = JSON.parse(readFileSync(agentRelayCloudAuthPath(env), 'utf8')) as unknown;
    if (!record(value) || typeof value.apiUrl !== 'string' || typeof value.accessToken !== 'string'
      || !value.accessToken.trim()) return undefined;
    return {
      apiUrl: value.apiUrl, accessToken: value.accessToken,
      ...(typeof value.accessTokenExpiresAt === 'string' ? { accessTokenExpiresAt: value.accessTokenExpiresAt } : {}),
      ...(typeof value.refreshToken === 'string' ? { refreshToken: value.refreshToken } : {}),
      ...(typeof value.refreshTokenExpiresAt === 'string' ? { refreshTokenExpiresAt: value.refreshTokenExpiresAt } : {}),
    };
  } catch { return undefined; }
}

function expired(value?: string): boolean {
  return value !== undefined && Date.parse(value) <= Date.now();
}

export function loginIsExpired(login: AgentRelayCloudLogin): boolean {
  return expired(login.accessTokenExpiresAt);
}

export function refreshTokenUsable(login: AgentRelayCloudLogin): boolean {
  return !!login.refreshToken?.trim() && !expired(login.refreshTokenExpiresAt);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function acquireLock(path: string, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    signal?.throwIfAborted();
    try { await mkdir(path, { mode: 0o700 }); return; }
    catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
    try {
      if (Date.now() - (await stat(path)).mtimeMs >= 30_000) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() - started >= 30_000) throw new Error('Cloud login lock timed out');
    await delay(50, undefined, { signal });
  }
}

async function persist(path: string, login: AgentRelayCloudLogin): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(login, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

type RefreshResult = { ok: true; login: AgentRelayCloudLogin } | { ok: false; detail: string };
const failed = (detail: string): RefreshResult => ({ ok: false, detail });

export async function refreshAgentRelayCloudLogin(options: {
  login: AgentRelayCloudLogin; baseUrl: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<RefreshResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const path = agentRelayCloudAuthPath(options.env);
  const lock = `${path}.lock`;
  try { await acquireLock(lock, signal); }
  catch {
    signal?.throwIfAborted();
    return failed('(the login store was locked)');
  }
  try {
    const latest = readAgentRelayCloudLogin(options.env);
    // Use the latest rotation when another process already refreshed this host.
    // As in relay, a different host keeps the original source: this invocation
    // already bound its base URL before contention; a retry reads the new host.
    const source = latest?.apiUrl === options.login.apiUrl ? latest : options.login;
    if (!loginIsExpired(source)) return { ok: true, login: source };
    if (!refreshTokenUsable(source)) return failed('(the refresh request failed)');
    let payload: unknown;
    try {
      const deadline = AbortSignal.timeout(10_000);
      const response = await fetch(`${options.baseUrl}/api/v1/auth/token/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: source.refreshToken }), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (!response.ok) return failed(`(HTTP ${response.status})`);
      payload = await response.json();
    } catch (error) {
      signal?.throwIfAborted();
      return failed(error instanceof SyntaxError
        ? '(the response was not a valid token set)' : '(the refresh request failed)');
    }
    if (!record(payload) || typeof payload.accessToken !== 'string' || !payload.accessToken.trim()
      || /[\r\n]/u.test(payload.accessToken) || /^(?:rk|ot)_live_/u.test(payload.accessToken.trim())
      || typeof payload.refreshToken !== 'string' || !payload.refreshToken.trim()
      || typeof payload.accessTokenExpiresAt !== 'string' || !(Date.parse(payload.accessTokenExpiresAt) > Date.now())) {
      return failed('(the response was not a valid token set)');
    }
    const refreshTokenExpiresAt = typeof payload.refreshTokenExpiresAt === 'string' && payload.refreshTokenExpiresAt.trim()
      ? payload.refreshTokenExpiresAt.trim() : source.refreshTokenExpiresAt;
    const login: AgentRelayCloudLogin = {
      apiUrl: typeof payload.apiUrl === 'string' && payload.apiUrl.trim() ? payload.apiUrl.trim() : source.apiUrl,
      accessToken: payload.accessToken, refreshToken: payload.refreshToken,
      accessTokenExpiresAt: payload.accessTokenExpiresAt,
      ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
    };
    try { await persist(path, login); }
    catch { signal?.throwIfAborted(); return failed('(the login store could not be written)'); }
    return { ok: true, login };
  } finally {
    try { await rm(lock, { recursive: true, force: true }); }
    catch {
      // Cleanup must not replace a typed persistence refusal with raw EACCES.
      signal?.throwIfAborted();
      return failed('(the login store could not be written)');
    }
  }
}
