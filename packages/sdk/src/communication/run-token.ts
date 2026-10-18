// Run-scoped Relaycast credential (`rt_live_`), delivered as an access-only
// file named by RELAY_RUN_TOKEN_FILE. Cloud refreshes the file outside the
// sandbox, so the value is re-read on every request and never cached, copied
// into env or argv, or written anywhere else. Errors never carry the value or
// the file contents.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const RUN_TOKEN_PREFIX = 'rt_live_';
const WORKSPACE_KEY_PREFIX = 'rk_live_';
const DEFAULT_BASE_URL = 'https://cast.agentrelay.com';

export type RelayCredential =
  | { kind: 'run-token'; file: string }
  | { kind: 'workspace-key'; workspaceKey: string };

export const MISSING_RELAY_CREDENTIAL =
  'Agent communication requires RELAY_API_KEY for an existing workspace or RELAY_RUN_TOKEN_FILE for a run-scoped token.';

/** Selects the Relay credential; a run token file wins over a workspace key. */
export function relayCredential(env: NodeJS.ProcessEnv = process.env): RelayCredential {
  const file = env.RELAY_RUN_TOKEN_FILE?.trim();
  if (file) return { kind: 'run-token', file };
  const key = env.RELAY_API_KEY?.trim();
  if (key?.startsWith(WORKSPACE_KEY_PREFIX)) return { kind: 'workspace-key', workspaceKey: key };
  throw new Error(MISSING_RELAY_CREDENTIAL);
}

/** Validates the access file's JSON and returns the token. Messages never include the value. */
export function parseRunTokenFile(text: string, now = Date.now()): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    // JSON.parse messages quote the input; replace them wholesale.
    throw new Error('RELAY_RUN_TOKEN_FILE does not contain valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RELAY_RUN_TOKEN_FILE must contain a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if ('refreshToken' in record || 'refresh_token' in record) {
    throw new Error('RELAY_RUN_TOKEN_FILE must be access-only and must not contain a refresh token.');
  }
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (!token.startsWith(RUN_TOKEN_PREFIX) || token.length === RUN_TOKEN_PREFIX.length) {
    throw new Error('RELAY_RUN_TOKEN_FILE token must be a non-empty rt_live_ run token.');
  }
  const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt)) throw new Error('RELAY_RUN_TOKEN_FILE expiresAt must be an ISO 8601 time.');
  if (expiresAt <= now) throw new Error('RELAY_RUN_TOKEN_FILE run token has expired.');
  return token;
}

function checkPath(file: string): void {
  if (!isAbsolute(file)) throw new Error('RELAY_RUN_TOKEN_FILE must be an absolute path.');
}

/** Synchronous check for preflight. Returns nothing so the value cannot escape. */
export function checkRunTokenFile(file: string, now = Date.now()): void {
  checkPath(file);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch {
    throw new Error('RELAY_RUN_TOKEN_FILE does not name a readable file.');
  }
  parseRunTokenFile(text, now);
}

/** A credential provider that reads the file on every call. */
export function runTokenProvider(file: string): () => Promise<string> {
  checkPath(file);
  return async () => {
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch {
      throw new Error('RELAY_RUN_TOKEN_FILE does not name a readable file.');
    }
    return parseRunTokenFile(text);
  };
}

export interface RunTokenAgents {
  register(input: { name: string; type: string }): Promise<{ token: string }>;
  delete(name: string): Promise<void>;
}

/**
 * Minimal Relaycast agent admin for run tokens: `POST /v1/agents` and
 * `DELETE /v1/agents/:name` only, the two agent routes that accept
 * `rt_live_` (relaycast#559). The Agent Relay messaging client takes one
 * static credential at construction, so it cannot re-read a rotating file.
 */
export function runTokenAgents(credential: () => Promise<string>,
  options: { baseUrl?: string; fetch?: typeof fetch } = {}): RunTokenAgents {
  const base = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await credential();
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined;
    let envelope: { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
    try { envelope = await response.json() as typeof envelope; } catch { envelope = undefined; }
    if (response.ok && envelope?.ok === true) return envelope.data;
    const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'unexpected_response';
    throw new Error(`Relaycast ${method} ${path} failed (${response.status} ${code}).`);
  }
  return {
    async register(input) {
      const data = await call('POST', '/v1/agents', input) as { token?: unknown } | undefined;
      if (typeof data?.token !== 'string' || !data.token) {
        throw new Error('Relaycast POST /v1/agents returned no agent token.');
      }
      return { token: data.token };
    },
    async delete(name) {
      await call('DELETE', `/v1/agents/${encodeURIComponent(name)}`);
    },
  };
}
