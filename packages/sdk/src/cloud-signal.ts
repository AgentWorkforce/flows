import { CloudFlowError, cloudFetch, cloudRunId, isCloudRecord, resolveCloudConnection,
  type CloudConnectionOptions } from './cloud-http.js';

const SIGNAL_NAME = /^[A-Za-z0-9_-]{1,80}$/u;
const MAX_BYTES = 4 * 1024;
const HELD_GET_MS = 25_000;

function signalPath(runId: string, name: string): string {
  cloudRunId(runId);
  if (!SIGNAL_NAME.test(name)) {
    throw new CloudFlowError('invalid_input', 'Signal name must contain only letters, digits, underscores, or hyphens (1–80 characters).');
  }
  return `/api/v1/workflows/runs/${runId}/signals/${name}`;
}

/** Store a run-scoped completion. Retrying the same JSON payload is safe. */
export async function postCloudSignal(
  runId: string, name: string, payload: unknown, options: CloudConnectionOptions = {},
): Promise<{ accepted: true; duplicate: boolean }> {
  const path = signalPath(runId, name);
  if (payload === undefined) throw new CloudFlowError('invalid_input', 'Signal payload must be present.');
  let body: string;
  try { body = JSON.stringify({ payload }); }
  catch { throw new CloudFlowError('invalid_input', 'Signal payload must be JSON serializable.'); }
  if (new TextEncoder().encode(body).byteLength > MAX_BYTES) {
    throw new CloudFlowError('invalid_input', 'Signal payload exceeds 4 KiB.');
  }
  const result = await cloudFetch(path, options, { method: 'POST', body, detail: true });
  if (!isCloudRecord(result) || result.accepted !== true || typeof result.duplicate !== 'boolean') {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid signal receipt.');
  }
  return { accepted: true, duplicate: result.duplicate };
}

/**
 * Wait on Cloud's held GET. A 204 is the server's 25-second safety timeout;
 * re-arm immediately with no client polling interval. The caller may abort.
 */
export async function waitForCloudSignal(
  runId: string, name: string, options: CloudConnectionOptions = {},
): Promise<unknown> {
  const path = signalPath(runId, name);
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout <= HELD_GET_MS) {
    throw new CloudFlowError('invalid_input', 'Signal requestTimeoutMs must exceed 25 seconds.');
  }
  for (;;) {
    options.signal?.throwIfAborted();
    const { baseUrl, token } = await resolveCloudConnection(options);
    const deadline = AbortSignal.timeout(requestTimeout);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}?waitMs=${HELD_GET_MS}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
        redirect: 'error',
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new CloudFlowError(deadline.aborted ? 'transient_error' : 'transport_error',
        'Cloud signal wait failed; retrying the wait is safe.');
    }
    if (response.status === 204) continue;
    if (!response.ok) throw new CloudFlowError('http_error', `Cloud signal wait failed with HTTP ${response.status}.`, response.status);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new CloudFlowError('invalid_response', 'Cloud returned an invalid signal.'); }
    if (!isCloudRecord(body) || !Object.hasOwn(body, 'payload') || typeof body.acceptedAt !== 'number') {
      throw new CloudFlowError('invalid_response', 'Cloud returned an invalid signal.');
    }
    return body.payload;
  }
}
