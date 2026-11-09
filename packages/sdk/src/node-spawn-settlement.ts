import type { JournalClient } from './journal-client.js';
import type { JournalEvent } from './journal-reader.js';
import type { NodeResultDelivery } from './node-spawn-result.js';
import { readNodeSpawnClaims, recordNodeSpawn, type NodeSpawnClaim } from './node-spawn-state.js';
import type { NodeSpawnRuntime } from './node-spawn-runtime.js';
import { NodeSpawnError, isRecord } from './node-spawn.js';

const SETTLEMENT_ATTEMPT_TIMEOUT_MS = 10_000;

export function durableNodeResultDelivery(
  runtime: NodeSpawnRuntime,
  path: string,
  initial: NodeSpawnClaim,
): NodeResultDelivery {
  const result = initial.result;
  if (result === undefined) throw new NodeSpawnError('Node result settlement requires a durable result');
  let claim = initial;
  let settling: Promise<void> | undefined;
  const settleOnce = async (): Promise<void> => {
    const current = claim.result;
    if (current === undefined) throw new NodeSpawnError('Durable node result disappeared before settlement');
    if (current.settlement === undefined) {
      throw new NodeSpawnError('Node result cannot settle before its journal intent is durable',
        'result_settlement_unprepared');
    }
    await settleInbox(runtime, current.settlementAction, current.inboxItemId,
      current.envelope.error ?? 'Relayflows rejected an invalid result');
    claim = { ...claim, result: { ...current, settlement: {
      ...current.settlement,
      settledAt: Date.now(), settledAs: current.settlementAction,
    } } };
    await recordNodeSpawn(path, claim);
  };
  const settle = (): Promise<void> => {
    if (settling !== undefined) return settling;
    const attempt = settleOnce();
    settling = attempt;
    void attempt.catch(() => { if (settling === attempt) settling = undefined; });
    return attempt;
  };
  return {
    inboxItemId: result.inboxItemId,
    messageId: result.messageId,
    envelope: result.envelope,
    settlementAction: result.settlementAction,
    prepareSettlement: async input => {
      const current = claim.result;
      if (current === undefined) throw new NodeSpawnError('Durable node result disappeared before settlement');
      const prior = current.settlement;
      if (prior !== undefined && prior.completionReason !== input.completionReason) {
        throw new NodeSpawnError('Node result settlement conflicts with its journal identity',
          'result_identity_mismatch');
      }
      if (prior?.settledAt !== undefined && prior.attempt !== input.attempt) {
        throw new NodeSpawnError('A settled node result cannot move to a different journal attempt',
          'result_identity_mismatch');
      }
      if (prior !== undefined && input.attempt < prior.attempt) {
        throw new NodeSpawnError('Node result settlement cannot move back to an older journal attempt',
          'result_identity_mismatch');
      }
      claim = { ...claim, result: { ...current, settlement:
        prior !== undefined && prior.attempt === input.attempt ? prior : {
          attempt: input.attempt,
          completionReason: input.completionReason,
          preparedAt: Date.now(),
        } } };
      await recordNodeSpawn(path, claim);
    },
    ack: settle,
  };
}

/** Reconciles journaled result settlements left by a crash or failed inbox call. */
export async function reconcileNodeResultSettlements(
  dataDir: string,
  runtime: NodeSpawnRuntime,
  journal: Pick<JournalClient, 'journalRead'>,
): Promise<number> {
  let pending = 0;
  for (const entry of await readNodeSpawnClaims(dataDir)) {
    const result = entry.claim.result;
    const settlement = result?.settlement;
    if (result === undefined || settlement === undefined || settlement.settledAt !== undefined) continue;
    if (entry.claim.baseUrl !== runtime.baseUrl
      || entry.claim.publisherId !== runtime.publisher.id
      || entry.claim.publisherName !== runtime.publisher.name) {
      throw new NodeSpawnError('Pending node-result settlement belongs to a different publisher identity',
        'publisher_identity_mismatch');
    }
    const terminal = await terminalEntry(journal, entry.claim.runId, entry.claim.stepId, settlement.attempt);
    if (terminal === undefined) { pending += 1; continue; }
    const exact = terminalMatchesResult(terminal, entry.claim, settlement, result);
    const action = exact ? result.settlementAction : 'fail';
    await settleInbox(runtime, action, result.inboxItemId,
      exact ? (result.envelope.error ?? 'Relayflows rejected an invalid result')
        : 'The journal completed this attempt with a different terminal outcome');
    const updated: NodeSpawnClaim = { ...entry.claim, result: { ...result, settlement: {
      ...settlement, settledAt: Date.now(), settledAs: action,
    } } };
    await recordNodeSpawn(entry.path, updated);
  }
  return pending;
}

function terminalMatchesResult(
  terminal: JournalEvent,
  claim: NodeSpawnClaim,
  settlement: NonNullable<NonNullable<NodeSpawnClaim['result']>['settlement']>,
  result: NonNullable<NodeSpawnClaim['result']>,
): boolean {
  const payload = isRecord(terminal.payload) ? terminal.payload : {};
  const tail = isRecord(payload.trajectory_tail) ? payload.trajectory_tail : {};
  const relayTask = isRecord(tail.relay_task) ? tail.relay_task : {};
  const execution = isRecord(relayTask.task_execution) ? relayTask.task_execution : {};
  return payload.completionReason === settlement.completionReason
    && execution.run_id === claim.runId
    && execution.step_id === claim.stepId
    && execution.dispatch_id === claim.idempotencyKey
    && execution.delivery_id === result.inboxItemId
    && execution.message_id === result.messageId;
}

async function terminalEntry(
  journal: Pick<JournalClient, 'journalRead'>,
  runId: string,
  stepId: string,
  attempt: number,
): Promise<JournalEvent | undefined> {
  let fromSeq = 1;
  while (true) {
    const entries = (await journal.journalRead(runId, fromSeq, 256)).entries as JournalEvent[];
    const terminal = entries.find(entry => entry.entry_type === 'step.completed'
      && entry.step_id === stepId && entry.attempt === attempt);
    if (terminal !== undefined || entries.length < 256) return terminal;
    const last = entries.at(-1);
    if (last === undefined || !Number.isSafeInteger(last.seq) || last.seq < fromSeq) {
      throw new NodeSpawnError('Journal settlement scan did not advance', 'result_settlement_unconfirmed');
    }
    fromSeq = last.seq + 1;
  }
}

async function settleInbox(
  runtime: NodeSpawnRuntime,
  action: 'ack' | 'fail',
  inboxItemId: string,
  error: string,
): Promise<void> {
  const pending = action === 'ack'
    ? runtime.inbox.inbox.ack({ inboxItemId, state: 'read', metadata: { relayflows_result: 'journaled' } })
    : runtime.inbox.inbox.fail({ inboxItemId, error, retry: false,
      metadata: { relayflows_result: 'rejected' } });
  await bounded(pending);
}

async function bounded(pending: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new NodeSpawnError(
      'Node-result inbox settlement did not confirm within its independent deadline',
      'result_settlement_unconfirmed')),
    SETTLEMENT_ATTEMPT_TIMEOUT_MS);
  });
  const outcome = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  try {
    const settled = await Promise.race([outcome, deadline]);
    if (!settled.ok) throw settled.error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
