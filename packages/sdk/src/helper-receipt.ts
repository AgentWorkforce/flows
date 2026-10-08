import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJsonFile, type WritebackResult, type WritebackReceipt } from '@relayfile/adapter-core/vfs-client';
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
    await writeJsonFile({ relayfileMountRoot: mount, writebackTimeoutMs: 0 }, provider, operation, path, body);
  }
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    let receipt: WritebackReceipt | undefined;
    try { receipt = JSON.parse(await readFile(intent.absolutePath, 'utf8')) as WritebackReceipt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      && JSON.stringify(receipt) !== JSON.stringify(intent.body)
      && (['created', 'path', 'id', 'externalId', 'ts', 'sha'].some(key => typeof receipt![key] === 'string')
        || typeof receipt.merged === 'boolean' || typeof receipt.merged === 'string')) {
      return { path: intent.path, absolutePath: intent.absolutePath, deliveryStatus: 'confirmed', receipt };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(250, remaining), undefined, { signal });
  } while (Date.now() <= deadline);
  throw new HelperWritebackPending(writeId, intent.path, runId);
}
