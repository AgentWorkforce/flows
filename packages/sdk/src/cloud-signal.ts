import { setTimeout as delay } from 'node:timers/promises';
import { HOSTED_SIGNAL_READ_TOKEN_ENV, holdSignalWait, signalPath as sharedSignalPath,
  type SignalErrorFactory } from '@relayflows/surface/signals';
import { CloudFlowError, cloudFetch, isCloudRecord, resolveCloudConnection,
  type CloudConnectionOptions } from './cloud-http.js';

const MAX_BYTES = 4 * 1024;

const cloudSignalError: SignalErrorFactory = (code, message, status) => new CloudFlowError(code, message, status);

function signalPath(runId: string, name: string): string {
  return sharedSignalPath(runId, name, cloudSignalError);
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
  // JSON.stringify omits a function, symbol, or toJSON() result of undefined.
  // This envelope has only one field, so {} means the payload was lost.
  if (body === '{}') throw new CloudFlowError('invalid_input', 'Signal payload must be JSON serializable.');
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
 * Wait on Cloud's held GET. The wire behaviour (validation, held GET, fast-204
 * backoff, error classification) is `@relayflows/surface/signals`' single
 * implementation, so the SDK and hosted flows cannot drift. The SDK keeps its
 * own credential resolution and throws `CloudFlowError`.
 */
export async function waitForCloudSignal(
  runId: string, name: string, options: CloudConnectionOptions = {},
): Promise<unknown> {
  return holdSignalWait(runId, name, { signal: options.signal, requestTimeoutMs: options.requestTimeoutMs }, {
    error: cloudSignalError,
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    connection: async () => {
      try {
        return await resolveCloudConnection(options);
      } catch (error) {
        // The hosted run's read-only credential is only a fallback for waits.
        // Explicit Cloud credentials and stored logins retain precedence, and
        // postCloudSignal never sees this token.
        const hostedToken = process.env[HOSTED_SIGNAL_READ_TOKEN_ENV];
        if (!(error instanceof CloudFlowError) || error.code !== 'configuration'
          || error.reason !== 'auth_missing' || options.token !== undefined
          || process.env['FLOWS_CLOUD_TOKEN'] !== undefined || hostedToken === undefined) throw error;
        return resolveCloudConnection({ ...options, token: hostedToken });
      }
    },
  });
}
