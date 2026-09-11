import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '@relayfile/adapter-core/vfs-client';
import type { RelayTransport } from '@relayfile/relay-helpers';
import type { JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';
import { atomicJson, readSlackReceipt, receiptPath, slackWriteback } from './slack-writeback.js';
import { invokeHelper, type HelperCall } from './yaml-helpers.js';
import { withWorkerLease } from './worker-lease.js';

export function helperMount(provider: string, env = process.env): string | undefined {
  const root = [env.RELAYFILE_MOUNT_PATH, env.WORKSPACE_ROOT, env.WORKFORCE_SANDBOX_ROOT,
    env.RELAYFILE_MOUNT_ROOT, env.RELAYFILE_ROOT].find(value => value?.trim());
  if (!root) return undefined;
  try { return statSync(join(root, provider)).isDirectory() ? root : undefined; }
  catch { return undefined; }
}

export function helperReady(provider: string): boolean {
  return (provider === 'slack' && process.env.RELAYFLOWS_SLACK_MOCK === '1') || helperMount(provider) !== undefined;
}

async function writeback(call: HelperCall, dataDir: string, runId: string, stepId: string, signal: AbortSignal) {
  // Exactly the TS surface's client, transport, idempotency stamp and receipt checks.
  if (call.provider === 'slack') return slackWriteback(call, dataDir, runId, stepId, signal);
  const mount = helperMount(call.provider);
  if (mount === undefined) throw new Error(`${call.provider} helper requires a relayfile mount`);
  const idempotencyKey = `${runId}:${stepId}`;
  const transport: RelayTransport = {
    async read() { throw new Error('Helper effect transport is write-only'); },
    async list() { throw new Error('Helper effect transport is write-only'); },
    async write(request) {
      signal.throwIfAborted();
      const body = { ...request.body as Record<string, unknown>, idempotencyKey };
      // Item updates keep the client's canonical path. Creates use a stable draft.
      const path = request.path.endsWith('.json') ? request.path
        : `${request.path}/draft-${createHash('sha256').update(idempotencyKey).digest('hex')}.json`;
      const result = await writeJsonFile({ relayfileMountRoot: mount }, request.provider,
        `write.${request.resource}`, path, body);
      if (result.deliveryStatus !== 'confirmed' || !result.receipt) {
        throw new Error(`${call.provider} writeback is pending; no delivery receipt`);
      }
      signal.throwIfAborted();
      return result;
    },
  };
  return invokeHelper(call, transport);
}

/** Existing lease/effect election protocol; provider verbs never enter the kernel. */
export async function completeHelperDispatch(
  client: JournalClient, dispatch: StepDispatchEvent, call: HelperCall, dataDir: string,
): Promise<void> {
  const surfacePath = `/${call.provider}`;
  const output = await withWorkerLease(client, dispatch, async signal => {
    const file = receiptPath(dataDir, dispatch.run_id, dispatch.step_id);
    let receipt: unknown;
    await client.performEffect({
      runId: dispatch.run_id, stepId: dispatch.step_id, attempt: dispatch.attempt,
      idempotencyKey: dispatch.idempotency_key, surfacePath,
      revisionBefore: 'pending', revisionAfter: `${dispatch.run_id}:${dispatch.step_id}`,
    }, async () => {
      try { receipt = await readSlackReceipt(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        receipt = await writeback(call, dataDir, dispatch.run_id, dispatch.step_id, signal);
        await atomicJson(file, receipt);
      }
      signal.throwIfAborted();
    });
    if (receipt === undefined) receipt = await readSlackReceipt(file);
    return { ...call, idempotencyKey: `${dispatch.run_id}:${dispatch.step_id}`, receipt };
  });
  await client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt,
    dispatch.idempotency_key, 'success', { output, started_pins: dispatch.pins, end_pins: dispatch.pins,
      effects: [{ surface_path: surfacePath, idempotency_key: dispatch.idempotency_key }] });
}
