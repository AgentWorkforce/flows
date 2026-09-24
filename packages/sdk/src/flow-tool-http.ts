import { canonicalize } from './canonical.js';
import { cloudConnection } from './cloud-http.js';
import { FlowToolError } from './flow-tool-contract.js';
import { flowToolOperationKey, type FlowToolRequest, type FlowToolTransport } from './flow-tool-client.js';

export interface FlowToolHttpOptions {
  /** Explicit trusted HTTPS API origin/base path. No implicit production endpoint. */
  readonly apiUrl: string;
  /** Dedicated scoped bearer; never included in definitions, bodies, errors or persisted state. */
  readonly token: string;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test/integration seam; the default is the standard fetch implementation. */
  readonly fetch?: typeof fetch;
}

function pathIsSafe(path: string): boolean {
  return /^\/api\/v1\/flow-tools(?:\/[A-Za-z_][A-Za-z0-9_-]{0,63}\/invoke)?$/.test(path)
    || /^\/api\/v1\/flow-runs\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?:\/(?:events|evidence|cancel|resume)|\/human\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\/answer)?$/.test(path);
}
async function* chunks(response: Response, maximumBytes: number): AsyncIterable<string> {
  if (!response.body) throw new FlowToolError('invalid_contract');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) throw new FlowToolError('invalid_contract');
      yield decoder.decode(chunk.value, { stream: true });
    }
    yield decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function refuse(status: number): never {
  const code = status === 400 || status === 422 ? 'invalid_contract' : status === 401 || status === 403 ? 'not_authorized' : status === 404 ? 'not_found'
    : status === 409 ? 'idempotency_conflict' : status === 501 ? 'unsupported' : 'unavailable';
  throw new FlowToolError(code);
}
function safeError(error: unknown): never {
  if (error instanceof FlowToolError) throw error;
  throw new FlowToolError('transport_error');
}

/** No automatic retry; the owner can repeat the same operation key after an ambiguous failure. */
export function createFlowToolHttpTransport(options: FlowToolHttpOptions): FlowToolTransport {
  // Reuse existing HTTPS/token validation, but never fall back to its ambient login store.
  if (typeof options.apiUrl !== 'string' || typeof options.token !== 'string') throw new FlowToolError('invalid_contract');
  let connection: { baseUrl: string; token: string };
  try { connection = cloudConnection({ apiUrl: options.apiUrl, token: options.token }); }
  catch { throw new FlowToolError('not_authorized'); }
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new FlowToolError('invalid_contract');
  const fetcher = options.fetch ?? globalThis.fetch;
  async function response(path: string, init: RequestInit, accept: string): Promise<Response> {
    if (!pathIsSafe(path)) throw new FlowToolError('invalid_contract');
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
    const result = await fetcher(`${connection.baseUrl}${path}`, {
      ...init, redirect: 'error', signal,
      headers: { ...init.headers, Authorization: `Bearer ${connection.token}`, Accept: accept },
    });
    if (!result.ok) { await result.body?.cancel(); refuse(result.status); }
    if (result.headers.get('content-type')?.toLowerCase().split(';')[0]?.trim() !== accept) {
      await result.body?.cancel(); throw new FlowToolError('invalid_contract');
    }
    return result;
  }
  return {
    async request(request: FlowToolRequest): Promise<unknown> {
      try {
        if (request.idempotencyKey !== undefined) flowToolOperationKey(request.idempotencyKey);
        if (request.method === 'POST' && request.idempotencyKey === undefined) throw new FlowToolError('invalid_contract');
        const result = await response(request.path, {
          method: request.method,
          headers: { ...(request.idempotencyKey === undefined ? {} : { 'Idempotency-Key': request.idempotencyKey }), 'Content-Type': 'application/json' },
          ...(request.body === undefined ? {} : { body: canonicalize(request.body) }),
        }, 'application/json');
        let body = '';
        for await (const chunk of chunks(result, 262144)) body += chunk;
        try { return JSON.parse(body); } catch { throw new FlowToolError('invalid_contract'); }
      } catch (error) { return safeError(error); }
    },
    async *events(path: string, after: number): AsyncIterable<unknown> {
      try {
        if (!path.endsWith('/events') || !Number.isSafeInteger(after) || after < 0) throw new FlowToolError('invalid_contract');
        const result = await response(path, { method: 'GET', headers: { 'Last-Event-ID': String(after) } }, 'text/event-stream');
        let buffer = '', frame: string[] = [], frameSize = 0;
        // Each bounded subscription may reconnect with its last validated cursor.
        for await (const chunk of chunks(result, 4 * 1024 * 1024)) {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            frameSize += line.length;
            if (frameSize > 65536) throw new FlowToolError('invalid_contract');
            if (line === '') {
              const event = parseFrame(frame);
              frame = []; frameSize = 0;
              if (event !== undefined) yield event;
            } else frame.push(line);
          }
          if (buffer.length > 65536) throw new FlowToolError('invalid_contract');
        }
        if (buffer.length || frame.some(line => !line.startsWith(':'))) throw new FlowToolError('invalid_contract');
      } catch (error) { safeError(error); }
    },
  };
}

function parseFrame(lines: string[]): unknown {
  const data: string[] = [];
  let id: string | undefined, name: string | undefined;
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'id' && id === undefined) id = value;
    else if (field === 'event' && name === undefined) name = value;
    else throw new FlowToolError('invalid_contract');
  }
  if (data.length === 0 && id === undefined && name === undefined) return undefined;
  if (id === undefined || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new FlowToolError('invalid_contract');
  let parsed: unknown;
  try { parsed = JSON.parse(data.join('\n')); } catch { throw new FlowToolError('invalid_contract'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).sequence !== Number(id)
    || (parsed as Record<string, unknown>).type !== name) throw new FlowToolError('invalid_contract');
  return parsed;
}
