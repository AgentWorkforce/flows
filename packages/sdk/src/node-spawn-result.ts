import { canonicalize } from './canonical.js';
import { isRecord, nonempty } from './node-spawn.js';

export const NODE_RESULT_PREFIX = 'RELAYFLOWS_RESULT_V1 ';

export interface NodeResultEnvelope {
  version: 1;
  run_id: string;
  step_id: string;
  dispatch_id: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: string;
  accounting?: { tokens_input?: number; tokens_output?: number };
}

export interface NodeResultCorrelation {
  runId: string;
  stepId: string;
  dispatchId: string;
}

interface InboxItem {
  id: string;
  message: { id: string; text: string; from: { id?: string; name?: string } };
}

export interface NodeResultInboxClient {
  inbox: {
    subscribe(input?: { signal?: AbortSignal }): AsyncIterable<InboxItem>;
    ack(input: { inboxItemId: string; state?: 'delivered' | 'read'; metadata?: Record<string, unknown> }): Promise<unknown>;
    fail(input: { inboxItemId: string; error: string; retry?: boolean; metadata?: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface NodeResultDelivery {
  inboxItemId: string;
  messageId: string;
  envelope: NodeResultEnvelope;
  /** Called only after the result has been durably appended to the run journal. */
  ack(): Promise<void>;
}

export function nodeResultInstruction(correlation: NodeResultCorrelation): string {
  const template = {
    version: 1,
    run_id: correlation.runId,
    step_id: correlation.stepId,
    dispatch_id: correlation.dispatchId,
    status: 'completed',
    output: { summary: 'replace with the final task result' },
  };
  return `When the task is finished, use the Agent Relay report command supplied in your spawn instructions exactly once. `
    + `The entire report body must be this prefix followed by one compact JSON object: ${NODE_RESULT_PREFIX}${canonicalize(template)}. `
    + 'Keep version, run_id, step_id, and dispatch_id unchanged. Set status to completed and output to the final JSON value, '
    + 'or set status to failed and error to a concise reason. Wait for the report command to succeed before ending the turn.';
}

export async function waitForNodeResult(
  client: NodeResultInboxClient,
  expected: { agentId: string; agentName: string } & NodeResultCorrelation,
  signal?: AbortSignal,
): Promise<NodeResultDelivery> {
  const iterator = client.inbox.subscribe({ signal })[Symbol.asyncIterator]();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve(iterator.return?.()).then(() => undefined);
    return closing;
  };
  try {
    for (;;) {
      const next = await abortableNext(iterator, signal, close);
      if (next.done) break;
      const item = next.value;
      signal?.throwIfAborted();
      if (item.message.from.id !== expected.agentId || item.message.from.name !== expected.agentName) continue;
      if (!item.message.text.startsWith(NODE_RESULT_PREFIX)) continue;
      let raw: unknown;
      try { raw = JSON.parse(item.message.text.slice(NODE_RESULT_PREFIX.length)); }
      catch { raw = undefined; }
      let envelope: NodeResultEnvelope;
      try { envelope = readNodeResult(raw, expected); }
      catch (error) {
        const reason = error instanceof Error ? error.message : 'Malformed Relayflows result';
        return {
          inboxItemId: item.id,
          messageId: item.message.id,
          envelope: { version: 1, run_id: expected.runId, step_id: expected.stepId,
            dispatch_id: expected.dispatchId, status: 'failed', error: reason },
          ack: async () => { await client.inbox.fail({ inboxItemId: item.id, error: reason, retry: false,
            metadata: { relayflows_result: 'rejected' } }); },
        };
      }
      return {
        inboxItemId: item.id,
        messageId: item.message.id,
        envelope,
        ack: async () => { await client.inbox.ack({ inboxItemId: item.id, state: 'read',
          metadata: { relayflows_result: 'journaled' } }); },
      };
    }
    signal?.throwIfAborted();
    throw new Error('Agent Relay result inbox ended before the spawned agent reported completion');
  } finally {
    if (signal?.aborted) void close();
    else await close();
  }
}

async function abortableNext<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
  close: () => Promise<void>,
): Promise<IteratorResult<T>> {
  signal?.throwIfAborted();
  const pending = iterator.next();
  if (signal === undefined) return pending;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  catch (error) {
    if (signal.aborted) {
      void pending.catch(() => undefined);
      void close();
    }
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export function readNodeResult(value: unknown, expected: NodeResultCorrelation): NodeResultEnvelope {
  if (!isRecord(value) || value.version !== 1 || value.run_id !== expected.runId
    || value.step_id !== expected.stepId || value.dispatch_id !== expected.dispatchId
    || !['completed', 'failed'].includes(String(value.status))) {
    throw new Error('Spawned agent result has invalid attempt correlation');
  }
  if (value.status === 'completed' && !Object.hasOwn(value, 'output')) {
    throw new Error('Spawned agent completion omitted its output');
  }
  if (value.status === 'failed' && !nonempty(value.error)) {
    throw new Error('Spawned agent failure omitted its reason');
  }
  if (value.accounting !== undefined && (!isRecord(value.accounting)
    || Object.entries(value.accounting).some(([key, amount]) => !['tokens_input', 'tokens_output'].includes(key)
      || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0))) {
    throw new Error('Spawned agent result has invalid accounting');
  }
  return value as unknown as NodeResultEnvelope;
}
