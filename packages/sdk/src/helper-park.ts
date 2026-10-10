import type { JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';
import { HelperWritebackPending } from './helper-receipt.js';

export function helperReceiptWaitId(stepId: string, attempt: number): string {
  return `helper-receipt:${stepId}:${attempt}`;
}

/** Journal a human-wait park before the worker connection closes.
 * Closing without this is a transport failure, and the default budget is one
 * extra retry: two receipt timeouts then fail the accepted write.
 */
export async function parkHelperReceipt(
  client: JournalClient, dispatch: StepDispatchEvent, error: HelperWritebackPending,
): Promise<void> {
  await client.stepWait(dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key, {
    wait_id: helperReceiptWaitId(dispatch.step_id, dispatch.attempt),
    prompt: error.message,
    requested_of: 'relayfile-receipt',
    options: ['resume'],
  });
}

/** Resume continues the same accepted write. Answering the park redispatches
 * the attempt; it does not submit another provider draft.
 */
export async function releaseHelperReceiptWaits(client: JournalClient, runId: string): Promise<void> {
  type WaitEntry = { seq?: number; entry_type: string; payload?: { wait_id?: string } };
  const entries: WaitEntry[] = [];
  let from = 1;
  for (;;) {
    const page = (await client.journalRead(runId, from, 1000)).entries as WaitEntry[];
    if (page.length === 0) break;
    entries.push(...page);
    const last = page[page.length - 1]?.seq;
    if (last === undefined || page.length < 1000) break;
    from = last + 1;
  }
  const closed = new Set(entries.filter(entry => entry.entry_type === 'wait.completed').map(entry => entry.payload?.wait_id));
  for (const entry of entries) {
    const waitId = entry.payload?.wait_id;
    if (entry.entry_type !== 'wait.human' || waitId === undefined || !waitId.startsWith('helper-receipt:') || closed.has(waitId)) continue;
    await client.eventEmit(runId, waitId, { answer: 'resume', answeredBy: 'flows-resume' });
  }
}
