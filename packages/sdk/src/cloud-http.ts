import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CloudConnectionOptions {
  /** Cloud application base URL; defaults to https://agentrelay.com/cloud. */
  apiUrl?: string;
  /** Scoped Cloud API token; never a Relay workspace key. */
  token?: string;
  signal?: AbortSignal;
  /** Bounds each HTTP request, never the hosted run. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

export class CloudFlowError extends Error {
  constructor(
    readonly code: 'configuration' | 'unsupported_source' | 'invalid_input' | 'invalid_response' | 'http_error'
      | 'transport_error' | 'transient_error' | 'unsupported_storage_backend' | 'sync_too_large' | 'sync_unsupported'
      | 'patch_conflict',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudFlowError';
  }
}

/**
 * The `agent-relay cloud login` credential store. Read only when neither the
 * `token` option nor `FLOWS_CLOUD_TOKEN` is set, so an explicit credential
 * always wins and this file can change shape without breaking a configured
 * caller. Its `apiUrl` becomes the default base URL for the same reason: a
 * login against one deployment must not send its token to another.
 */
export function agentRelayCloudAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['AGENT_RELAY_HOME'] ?? join(homedir(), '.agentworkforce/relay'), 'cloud-auth.json');
}

export interface AgentRelayCloudLogin {
  apiUrl: string;
  accessToken: string;
  /** ISO-8601; the store carries it, so an expired login refuses with a real reason. */
  accessTokenExpiresAt?: string;
}

export function readAgentRelayCloudLogin(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
): AgentRelayCloudLogin | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(agentRelayCloudAuthPath(env)));
  } catch {
    return undefined;
  }
  if (!isCloudRecord(parsed) || typeof parsed.apiUrl !== 'string' || typeof parsed.accessToken !== 'string'
    || !parsed.accessToken.trim()) return undefined;
  return {
    apiUrl: parsed.apiUrl, accessToken: parsed.accessToken,
    ...(typeof parsed.accessTokenExpiresAt === 'string' ? { accessTokenExpiresAt: parsed.accessTokenExpiresAt } : {}),
  };
}

export function cloudConnection(options: CloudConnectionOptions): { baseUrl: string; token: string } {
  let rawToken = options.token ?? process.env['FLOWS_CLOUD_TOKEN'];
  let loginApiUrl: string | undefined;
  if (rawToken === undefined) {
    const login = readAgentRelayCloudLogin();
    if (login !== undefined) {
      const expiresAt = login.accessTokenExpiresAt === undefined ? Number.NaN : Date.parse(login.accessTokenExpiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        throw new CloudFlowError('configuration',
          'The agent-relay cloud login has expired. Run `agent-relay cloud login` again, or set FLOWS_CLOUD_TOKEN.');
      }
      rawToken = login.accessToken;
      loginApiUrl = login.apiUrl;
    }
  }
  const token = rawToken?.trim();
  if (!token || /[\r\n]/u.test(rawToken!) || /^(?:rk|ot)_live_/u.test(token)) {
    throw new CloudFlowError('configuration',
      'Set FLOWS_CLOUD_TOKEN to a scoped Cloud API token (workflow:invoke:write and workflow:runs:read), '
      + 'or sign in with `agent-relay cloud login`.');
  }
  let url: URL;
  try {
    url = new URL(options.apiUrl ?? process.env['FLOWS_CLOUD_URL'] ?? loginApiUrl ?? 'https://agentrelay.com/cloud');
  } catch {
    throw new CloudFlowError('configuration', 'FLOWS_CLOUD_URL must be an absolute Cloud application base URL.');
  }
  if (url.protocol !== 'https:'
    || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9/_-]*$/u.test(url.pathname)) {
    throw new CloudFlowError('configuration', 'Cloud URL must use HTTPS and a plain base path.');
  }
  const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  // A login-store token is bound to the deployment that issued it. An explicit
  // URL that names another deployment gets no token at all — set
  // FLOWS_CLOUD_TOKEN for that deployment instead.
  if (loginApiUrl !== undefined) {
    let issued: string | undefined;
    try {
      const login = new URL(loginApiUrl);
      issued = `${login.origin}${login.pathname.replace(/\/+$/u, '')}`;
    } catch { issued = undefined; }
    if (issued !== baseUrl) {
      throw new CloudFlowError('configuration',
        `The agent-relay cloud login was issued for ${loginApiUrl}, not ${baseUrl}. `
        + 'Set FLOWS_CLOUD_TOKEN for that deployment, or unset FLOWS_CLOUD_URL to use the login.');
    }
  }
  return { baseUrl, token };
}

export async function cloudRequest(
  path: string,
  options: CloudConnectionOptions,
  body?: unknown,
): Promise<unknown> {
  return cloudFetch(path, options, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', body: JSON.stringify(body), contentType: 'application/json' });
}

export interface CloudFetchInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string | Uint8Array;
  contentType?: string;
  /**
   * A run-scoped token issued by Cloud for one upload (the `prepare` receipt's
   * storage credential). Used instead of the configured token for that request
   * only; it is never persisted or logged.
   */
  bearerToken?: string;
  /**
   * On a non-2xx response, read a `{ code, error }` refusal from the body and
   * name it. Only those two string fields are ever surfaced, so a route that
   * answers with structured refusals (the deploy routes) can explain itself
   * without this client echoing arbitrary response bodies.
   */
  detail?: boolean;
}

/** One authenticated Cloud request. Every transport error is typed; no retries. */
export async function cloudFetch(
  path: string,
  options: CloudConnectionOptions,
  init: CloudFetchInit,
): Promise<unknown> {
  const { baseUrl, token } = cloudConnection(options);
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new CloudFlowError('configuration', 'requestTimeoutMs must be a positive 32-bit integer.');
  }
  const bearer = init.bearerToken ?? token;
  if (/[\r\n]/u.test(bearer) || !bearer.trim()) {
    throw new CloudFlowError('invalid_response', 'Cloud issued an unusable storage credential.');
  }
  const deadline = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': init.contentType ?? 'application/json',
      },
      ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : new Blob([init.body]) }),
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      // A redirect must never carry the credential to a different origin.
      redirect: 'error',
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw transportError(deadline.aborted ? deadline.reason : error);
  }
  if (!response.ok) {
    // Do not echo server response bodies: they may contain credentials or source.
    const refusal = init.detail ? await structuredRefusal(response) : undefined;
    throw new CloudFlowError('http_error', refusal === undefined
      ? `Cloud request failed with HTTP ${response.status}.`
      : `Cloud refused (${refusal.code}): ${refusal.error}`, response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof SyntaxError)) throw transportError(deadline.aborted ? deadline.reason : error);
    throw new CloudFlowError('invalid_response', 'Cloud returned a non-JSON response.');
  }
}

async function structuredRefusal(response: Response): Promise<{ code: string; error: string } | undefined> {
  let body: unknown;
  try { body = await response.json(); } catch { return undefined; }
  if (!isCloudRecord(body) || typeof body.code !== 'string' || typeof body.error !== 'string') return undefined;
  if (!/^[a-z0-9_]{1,64}$/u.test(body.code) || body.error.length > 500) return undefined;
  return { code: body.code, error: body.error };
}

// Defensive path-segment constraint; accepting a new server ID format needs an SDK change.
export function cloudRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new CloudFlowError('invalid_response', 'Cloud run ID must contain only letters, digits, underscores, or hyphens.');
  }
  return value;
}

export function isCloudRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transportError(error: unknown): CloudFlowError {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isCloudRecord(cause) ? cause.code : undefined;
  const transient = (error instanceof Error && error.name === 'TimeoutError')
    || ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(String(code));
  return new CloudFlowError(transient ? 'transient_error' : 'transport_error',
    transient ? 'Cloud transport temporarily unavailable.' : 'Cloud transport failed; check TLS and the configured URL (redirects are refused).');
}
