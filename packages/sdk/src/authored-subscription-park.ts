import type { AuthoredFlowSuspension } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';

/** Recover the handoff report without starting a worker on a still-open wait. */
export async function readSubscriptionPark(
  journal: JournalClient, runId: string,
): Promise<AuthoredFlowSuspension | undefined> {
  const open = new Map<string, { subscription_id: string; phase: 'activation' | 'event_wait' }>();
  const prepared = new Map<string, Record<string, unknown>>();
  let from = 1;
  for (;;) {
    const { entries } = await journal.journalRead(runId, from, 500);
    for (const raw of entries) {
      const entry = raw as { seq: number; entry_type: string; step_id?: string; payload: Record<string, unknown> };
      from = entry.seq + 1;
      const p = entry.payload;
      if (entry.entry_type === 'subscription.prepared') prepared.set(String(p['subscription_id']), p);
      if (entry.entry_type === 'wait.event' && entry.step_id === 'authored-root'
        && typeof p['event_key'] === 'string' && p['event_key'].startsWith('subscription.park:')) {
        const park = JSON.parse(p['event_key'].slice('subscription.park:'.length)) as Record<string, unknown>;
        if (typeof park['subscription_id'] !== 'string'
          || (park['phase'] !== 'activation' && park['phase'] !== 'event_wait')) {
          throw new Error('malformed durable subscription park');
        }
        open.set(String(p['wait_id']), { subscription_id: park['subscription_id'], phase: park['phase'] });
      }
      if (entry.entry_type === 'wait.completed') open.delete(String(p['wait_id']));
    }
    if (entries.length < 500) break;
  }
  const park = [...open.values()].at(-1);
  if (park === undefined) return undefined;
  const p = prepared.get(park.subscription_id);
  if (p === undefined || typeof p['stream'] !== 'string' || typeof p['deadline_at_ms'] !== 'number') {
    throw new Error('subscription park has no prepared boundary');
  }
  const common = { subscriptionId: park.subscription_id, stream: p['stream'], deadlineAtMs: p['deadline_at_ms'] };
  if (park.phase === 'event_wait') return { kind: 'event_wait', ...common };
  if (!Array.isArray(p['event_types']) || !p['event_types'].every(v => typeof v === 'string')
    || typeof p['settle_ms'] !== 'number' || typeof p['idle_ms'] !== 'number' || typeof p['include_self'] !== 'boolean') {
    throw new Error('subscription park has malformed prepared facts');
  }
  return { kind: 'activation', ...common, eventTypes: p['event_types'], settleMs: p['settle_ms'],
    idleMs: p['idle_ms'], includeSelf: p['include_self'],
    ...(p['pattern'] === undefined || p['pattern'] === null ? {} : { pattern: p['pattern'] as Record<string, unknown> }) };
}
