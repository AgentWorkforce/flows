import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { writeJsonFile, RelayfileWritebackPendingError, type WritebackResult } from '@relayfile/adapter-core/vfs-client';
import { atomicJson, receiptPath } from './helper-storage.js';

export const DEFAULT_HELPER_RECEIPT_TIMEOUT_MS = 60_000;
export function helperReceiptTimeoutMs(env = process.env): number {
  const raw = env.RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_HELPER_RECEIPT_TIMEOUT_MS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS must be a positive integer in milliseconds');
  }
  return value;
}

export class HelperDeliveryError extends Error {}
export class HelperWritebackPendingError extends HelperDeliveryError {
  readonly code = 'helper_writeback_pending';
  constructor(readonly writeId: string, readonly relayPath: string) {
    super(`helper_writeback_pending: write ${writeId} accepted at ${relayPath}; delivery receipt still pending. Receipt budget exhausted; this run is terminal. A new run may post again.`);
  }
}

/** Failed agent output survives in the journal as rendered verification.detail. */
export function helperPendingDiagnostic(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  try {
    const value = JSON.parse(detail) as Record<string, unknown>;
    if (value?.code === 'helper_writeback_pending' && typeof value.diagnostic === 'string') return value.diagnostic;
    // Authored roots persist the typed child's rendered message as { error }.
    if (typeof value?.error === 'string' && value.error.startsWith('helper_writeback_pending:')) return value.error;
  } catch { /* An unrelated failure may carry plain text. */ }
  return undefined;
}

interface PendingWrite {
  writeId: string;
  relayPath: string;
  draft: Record<string, unknown>;
}

export function pendingWritePath(dataDir: string, runId: string, stepId: string): string {
  return receiptPath(dataDir, runId, stepId).replace(/\.json$/, '.pending.json');
}

function mountedPath(mount: string, relayPath: string): string {
  const root = resolve(mount);
  const path = resolve(root, relayPath.replace(/^\/+/, ''));
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Helper receipt path escapes the relayfile mount');
  }
  return path;
}

/** Matches @relayfile/adapter-core 0.6.2's waitForReceipt predicate. */
export function isHelperReceipt(value: unknown, draft: Record<string, unknown>): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value) === JSON.stringify(draft)) return false;
  const record = value as Record<string, unknown>;
  return ['created', 'path', 'id', 'externalId'].some(key => typeof record[key] === 'string')
    || typeof record.merged === 'boolean' || typeof record.merged === 'string';
}

async function currentReceipt(path: string, draft: Record<string, unknown>) {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isHelperReceipt(value, draft) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The daemon replaces the draft with a receipt in place (adapter-core's contract).
 * Accepted records are replayed after crash/lease-loss re-dispatch, not after a
 * terminal budget-exhausted completion. Paths resolve against the current mount.
 */
export async function receiptWriteback(
  mount: string, provider: string, operation: string, relayPath: string,
  draft: Record<string, unknown>, dataDir: string, runId: string, stepId: string, signal: AbortSignal,
): Promise<WritebackResult> {
  const budget = helperReceiptTimeoutMs();
  signal.throwIfAborted();
  const file = pendingWritePath(dataDir, runId, stepId);
  let pending: PendingWrite | undefined;
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as PendingWrite | null;
    if (!value || typeof value.writeId !== 'string' || !value.writeId
      || typeof value.relayPath !== 'string' || !value.draft
      || typeof value.draft !== 'object' || Array.isArray(value.draft)) {
      throw new Error('Invalid helper accepted-write record');
    }
    pending = value;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (pending && pending.relayPath !== relayPath) {
    throw new Error('Helper pending write does not match the computed draft path');
  }
  const absolutePath = mountedPath(mount, pending?.relayPath ?? relayPath);
  const storedDraft = pending?.draft ?? draft;
  const confirmed = (receipt: Record<string, unknown>): WritebackResult => ({ path: relayPath, absolutePath, deliveryStatus: 'confirmed', receipt });
  // Protect the rename -> accepted-record crash window if delivery already finished.
  // Canonical item paths can contain the old provider object before an update.
  // Only a per-run draft (or an accepted record) proves this write owns the path.
  const existing = pending || /\/draft-[a-f0-9]{64}\.json$/.test(relayPath)
    ? await currentReceipt(absolutePath, storedDraft) : undefined;
  if (existing) return confirmed(existing);
  if (!pending) {
    let writeId = `${runId}:${stepId}`;
    let result: WritebackResult | undefined;
    try { result = await writeJsonFile({ relayfileMountRoot: mount, writebackTimeoutMs: 0 }, provider, operation, relayPath, draft); }
    catch (error) {
      if (!(error instanceof RelayfileWritebackPendingError)) throw error;
      writeId = error.opId;
    }
    // Only adapter acceptance authorizes a record: a failed write must remain retryable.
    pending = { writeId, relayPath, draft };
    await atomicJson(file, pending);
    if (result?.deliveryStatus === 'confirmed' && result.receipt) return result;
  }
  const deadline = performance.now() + budget;
  for (;;) {
    signal.throwIfAborted();
    const receipt = await currentReceipt(absolutePath, storedDraft);
    if (receipt) return confirmed(receipt);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new HelperWritebackPendingError(pending.writeId, relayPath);
    await delay(Math.min(250, remaining), undefined, { signal });
  }
}
