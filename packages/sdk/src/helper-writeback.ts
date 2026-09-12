import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeJsonFile, readJsonFile, listJsonFiles, type WritebackResult } from '@relayfile/adapter-core/vfs-client';
import type { RelayTransport, RelayTransportRequest } from '@relayfile/relay-helpers/transport';
import { helperClients, helperProviders, invokeHelper, type HelperCall } from '@relayflows/surface/runtime';
import { providerMount } from './slack-preflight.js';
import { atomicJson } from './helper-storage.js';
import type { SlackCall } from './slack-writeback.js';

export class HelperDeliveryError extends Error {}

export async function helperWriteback(call: HelperCall, dataDir: string, runId: string, stepId: string, signal: AbortSignal): Promise<unknown> {
  const factory = helperClients[call.provider];
  if (!factory) throw new Error(`No writeback client for ${call.provider}`);
  const { transport } = helperTransport(call, dataDir, runId, stepId, signal);
  try { return await invokeHelper(factory, call, transport); }
  catch (cause) { throw new HelperDeliveryError(cause instanceof Error ? cause.message : String(cause), { cause }); }
}

/** One transport for every provider, including Slack. Only confirmed writes succeed. */
export function helperTransport(call: HelperCall | SlackCall, dataDir: string, runId: string, stepId: string, signal: AbortSignal) {
  const provider = helperProviders.find(p => p.provider === call.provider);
  if (!provider) throw new Error(`Unknown helper provider ${call.provider}`);
  const mock = process.env[provider.mockEnv] === '1';
  const mount = providerMount(provider.provider);
  const options = () => {
    signal.throwIfAborted();
    if (!mount) throw new Error(`${provider.provider} requires a relayfile mount`);
    return { relayfileMountRoot: mount };
  };
  const idempotencyKey = `${runId}:${stepId}`;
  let deliveredRef = '';
  const transport: RelayTransport = {
    async read<T>(request: RelayTransportRequest): Promise<T> {
      signal.throwIfAborted();
      if (mock) return {} as T;
      return readJsonFile<T>(options(), call.provider, `read.${request.resource}`, request.path);
    },
    async list<T>(request: RelayTransportRequest): Promise<T[]> {
      signal.throwIfAborted();
      if (mock) return [];
      return (await listJsonFiles<T>(options(), call.provider, `list.${request.resource}`, request.path)).map(file => file.value);
    },
    async write(request) {
      signal.throwIfAborted();
      if (request.provider !== call.provider) throw new Error('Helper transport provider mismatch');
      if (!mock && call.provider === 'notion' && call.verb === 'appendBlock') {
        throw new Error('Notion appendBlock has no upstream mount writeback route');
      }
      if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
        throw new Error('Helper writeback requires a JSON object');
      }
      const body: Record<string, unknown> = { ...request.body as Record<string, unknown>, idempotencyKey };
      // Item paths must remain canonical; only collections receive a draft filename.
      const draft = /\.[a-z]+$/i.test(request.path) ? request.path
        : `${request.path}/draft-${createHash('sha256').update(idempotencyKey).digest('hex')}.json`;
      let result: WritebackResult;
      if (mock) {
        deliveredRef = `mock-ref-${stepId}`;
        result = { path: deliveredRef, absolutePath: draft, deliveryStatus: 'confirmed', receipt: { externalId: `mock-${stepId}` } };
        await atomicJson(join(dataDir, 'mock-writeback', call.provider, `${stepId}.json`), {
          ...call, ...body,
          ...(call.provider === 'slack' ? { channel: request.parameters.channelId,
            ...(body.parentRef === undefined ? {} : { replyTo: body.parentRef }) } : {}),
          runId, stepId, request: { ...request, body }, receipt: result.receipt,
        });
      } else {
        try { result = await writeJsonFile(options(), call.provider, `write.${request.resource}`, draft, body); }
        catch (cause) {
          // Upstream created() converts pending/terminal adapter errors into values.
          // A journal effect must fail instead of confirming an undelivered write.
          throw new Error(`${call.provider} writeback failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
        if (result.deliveryStatus !== 'confirmed' || !result.receipt) throw new Error(`${call.provider} writeback is pending; no delivery receipt`);
        if (call.provider === 'slack' && call.verb !== 'react' && !result.receipt.externalId && !result.receipt.ts) throw new Error('Slack writeback has no delivered timestamp');
        deliveredRef = result.path;
      }
      signal.throwIfAborted();
      return result;
    },
  };
  return { transport, deliveredRef: () => deliveredRef };
}
