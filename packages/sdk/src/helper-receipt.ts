import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJsonFile, type WritebackReceipt, type WritebackResult } from '@relayfile/adapter-core/vfs-client';
import { atomicJson, receiptPath, readHelperReceipt } from './helper-storage.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

export class HelperWritebackPending extends AuthoredFlowExecutionError {
  constructor(readonly writeId: string, readonly path: string, runId: string) {
    super('helper_writeback_pending', `write ${writeId} accepted or submission interrupted; delivery receipt pending at ${path}. Resume to wait; do not re-issue the write.`, undefined, runId);
  }
}

export function helperReceiptTimeoutMs(): number {
  const value = process.env.RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS;
  if (value === undefined || value.trim() === '') return 60_000;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS must be a positive integer');
  return timeout;
}

/** Persist intent before mount I/O: an interrupted submission is never blindly repeated. */
export async function writeHelperDraft(mount: string, provider: string, operation: string,
  path: string, body: Record<string, unknown>, dataDir: string, runId: string, stepId: string,
  signal: AbortSignal): Promise<WritebackResult> {
  const timeout = helperReceiptTimeoutMs();
  const writeId = `${runId}:${stepId}`;
  const file = receiptPath(dataDir, runId, stepId) + '.pending';
  let intent: { path: string; absolutePath: string; body: Record<string, unknown> };
  try { intent = await readHelperReceipt(file) as typeof intent; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const absolutePath = resolve(mount, path.replace(/^\/+/, ''));
    const inside = relative(mount, absolutePath);
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('Helper path escapes mount root');
    intent = { path, absolutePath, body };
    await atomicJson(file, intent);
    signal.throwIfAborted();
    const submitted = await writeJsonFile({ relayfileMountRoot: mount, writebackTimeoutMs: 0 }, provider, operation, path, body);
    if (providerReceipt(submitted.receipt, intent.body)) return { ...submitted, deliveryStatus: 'confirmed', receipt: submitted.receipt };
  }
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    let receipt: WritebackReceipt | undefined;
    try { receipt = JSON.parse(await readFile(intent.absolutePath, 'utf8')) as WritebackReceipt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    // Identity fields only. A path, timestamp, or error object written while
    // the adapter is still flushing is not a provider delivery.
    if (providerReceipt(receipt, intent.body)) {
      return { path: intent.path, absolutePath: intent.absolutePath, deliveryStatus: 'confirmed', receipt };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(250, remaining), undefined, { signal });
  } while (Date.now() <= deadline);
  throw new HelperWritebackPending(writeId, intent.path, runId);
}

/** A provider id the draft did not already carry. Path and created are not delivery. */
function providerReceipt(receipt: WritebackReceipt | undefined, draft: Record<string, unknown>): receipt is WritebackReceipt {
  if (receipt === undefined || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  return (['id', 'externalId', 'ts'] as const).some(key => {
    const value = receipt[key];
    return typeof value === 'string' && value.length > 0 && value !== draft[key];
  });
}
