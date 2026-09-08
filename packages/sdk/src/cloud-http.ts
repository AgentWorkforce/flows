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
    readonly code: 'configuration' | 'unsupported_source' | 'invalid_response' | 'http_error',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudFlowError';
  }
}

export function cloudConnection(options: CloudConnectionOptions): { baseUrl: string; token: string } {
  const rawToken = options.token ?? process.env['FLOWS_CLOUD_TOKEN'];
  const token = rawToken?.trim();
  if (!token || /[\r\n]/u.test(rawToken!) || /^(?:rk|ot)_live_/u.test(token)) {
    throw new CloudFlowError('configuration',
      'Set FLOWS_CLOUD_TOKEN to a scoped Cloud API token (workflow:invoke:write and workflow:runs:read).');
  }
  let url: URL;
  try {
    url = new URL(options.apiUrl ?? process.env['FLOWS_CLOUD_URL'] ?? 'https://agentrelay.com/cloud');
  } catch {
    throw new CloudFlowError('configuration', 'FLOWS_CLOUD_URL must be an absolute Cloud application base URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9/_-]*$/u.test(url.pathname)) {
    throw new CloudFlowError('configuration', 'Cloud URL must use HTTPS and a plain base path (HTTP is allowed only on loopback).');
  }
  return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/u, '')}`, token };
}

export async function cloudRequest(
  path: string,
  options: CloudConnectionOptions,
  body?: unknown,
): Promise<unknown> {
  const { baseUrl, token } = cloudConnection(options);
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new CloudFlowError('configuration', 'requestTimeoutMs must be a positive 32-bit integer.');
  }
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    // A redirect must never carry the credential to a different origin.
    redirect: 'error',
  });
  if (!response.ok) {
    // Do not echo server response bodies: they may contain credentials or source.
    throw new CloudFlowError('http_error', `Cloud request failed with HTTP ${response.status}.`, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new CloudFlowError('invalid_response', 'Cloud returned a non-JSON response.');
  }
}

export function cloudRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new CloudFlowError('invalid_response', 'Cloud run ID must contain only letters, digits, underscores, or hyphens.');
  }
  return value;
}

export function isCloudRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
