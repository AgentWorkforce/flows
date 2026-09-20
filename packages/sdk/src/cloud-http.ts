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

/** A refusal Cloud answered as JSON: only these fields are ever read. */
export interface CloudRefusal {
  code: string;
  error: string;
  /** Version-only descriptions, when a route names what it wanted vs. got. */
  expected?: { packageName?: string; version?: string };
  received?: { packageName?: string; version?: string };
}

/**
 * Narrows a `configuration` failure to the thing that was wrong.
 *
 * `configuration` has always covered every local misconfiguration, and its
 * message says which. A caller that must answer with a *code* — the read
 * verbs print `REFUSED [cloud_auth_missing]` and name `agent-relay cloud
 * login` — cannot get that from prose without matching on it. Optional and
 * additive: every existing `catch` on `code === 'configuration'` is unchanged.
 */
export type CloudConfigurationReason =
  | 'auth_missing'
  | 'auth_expired'
  | 'url_invalid'
  | 'url_mismatch'
  | 'timeout_invalid';

export class CloudFlowError extends Error {
  /** Set only for `configuration`; see {@link CloudConfigurationReason}. */
  reason?: CloudConfigurationReason;

  constructor(
    readonly code: 'configuration' | 'unsupported_source' | 'invalid_input' | 'invalid_response' | 'http_error'
      | 'transport_error' | 'transient_error' | 'unsupported_storage_backend' | 'sync_too_large' | 'sync_unsupported'
      | 'patch_conflict' | 'integration_not_connected',
    message: string,
    readonly status?: number,
    readonly refusal?: CloudRefusal,
  ) {
    super(message);
    this.name = 'CloudFlowError';
  }
}

/** A `configuration` refusal that also carries its {@link CloudConfigurationReason}. */
function configurationError(reason: CloudConfigurationReason, message: string): CloudFlowError {
  const error = new CloudFlowError('configuration', message);
  error.reason = reason;
  return error;
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
        throw configurationError('auth_expired',
          'The agent-relay cloud login has expired. Run `agent-relay cloud login` again, or set FLOWS_CLOUD_TOKEN.');
      }
      rawToken = login.accessToken;
      loginApiUrl = login.apiUrl;
    }
  }
  const token = rawToken?.trim();
  if (!token || /[\r\n]/u.test(rawToken!) || /^(?:rk|ot)_live_/u.test(token)) {
    throw configurationError('auth_missing',
      'Set FLOWS_CLOUD_TOKEN to a scoped Cloud API token (workflow:invoke:write and workflow:runs:read), '
      + 'or sign in with `agent-relay cloud login`.');
  }
  let url: URL;
  try {
    url = new URL(options.apiUrl ?? process.env['FLOWS_CLOUD_URL'] ?? loginApiUrl ?? 'https://agentrelay.com/cloud');
  } catch {
    throw configurationError('url_invalid', 'FLOWS_CLOUD_URL must be an absolute Cloud application base URL.');
  }
  if (url.protocol !== 'https:'
    || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9/_-]*$/u.test(url.pathname)) {
    throw configurationError('url_invalid', 'Cloud URL must use HTTPS and a plain base path.');
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
      throw configurationError('url_mismatch',
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
    throw configurationError('timeout_invalid', 'requestTimeoutMs must be a positive 32-bit integer.');
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
    // Reading the body is itself a transport step: a cancellation or timeout
    // there keeps its own classification instead of becoming an http_error.
    let refusal: CloudRefusal | undefined;
    if (init.detail) {
      try {
        refusal = await structuredRefusal(response);
      } catch (error) {
        options.signal?.throwIfAborted();
        throw transportError(deadline.aborted ? deadline.reason : error);
      }
    }
    throw new CloudFlowError('http_error', refusal === undefined
      ? `Cloud request failed with HTTP ${response.status}.`
      : `Cloud refused (${refusal.code}): ${refusal.error}`, response.status, refusal);
  }
  try {
    return await response.json();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof SyntaxError)) throw transportError(deadline.aborted ? deadline.reason : error);
    throw new CloudFlowError('invalid_response', 'Cloud returned a non-JSON response.');
  }
}

const REFUSAL_CODE = /^[a-z0-9_]{1,64}$/u;

/**
 * Routes answer either `{ code, error }` or a bare `{ error: "<code>" }`;
 * both are read, and an optional `expected`/`received` pair is reduced to
 * package name and version. Nothing else in the body is looked at.
 */
async function structuredRefusal(response: Response): Promise<CloudRefusal | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // Only a body that is not JSON is "no structured refusal"; an aborted or
    // timed-out read is a transport failure and propagates.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isCloudRecord(body) || typeof body.error !== 'string' || body.error.length > 500) return undefined;
  const code = typeof body.code === 'string' ? body.code : body.error;
  if (!REFUSAL_CODE.test(code)) return undefined;
  const versionOnly = (value: unknown): CloudRefusal['expected'] => {
    if (!isCloudRecord(value)) return undefined;
    const out: { packageName?: string; version?: string } = {};
    if (typeof value.packageName === 'string' && value.packageName.length <= 100) out.packageName = value.packageName;
    if (typeof value.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/u.test(value.version)) out.version = value.version;
    return out;
  };
  const expected = versionOnly(body.expected);
  const received = versionOnly(body.received);
  return { code, error: body.error, ...(expected ? { expected } : {}), ...(received ? { received } : {}) };
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
