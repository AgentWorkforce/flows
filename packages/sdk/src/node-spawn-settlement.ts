import type { JournalClient } from './journal-client.js';
import type { JournalEvent } from './journal-reader.js';
import type { NodeResultDelivery } from './node-spawn-result.js';
import { nodeSpawnCleanupRequired, releaseNodeSpawnClaim } from './node-spawn-cleanup.js';
import { readNodeSpawnClaim, readNodeSpawnClaims, recordNodeSpawn,
  type NodeSpawnClaim } from './node-spawn-state.js';
import type { NodeSpawnRuntime } from './node-spawn-runtime.js';
import { NodeSpawnError, isRecord } from './node-spawn.js';

const SETTLEMENT_ATTEMPT_TIMEOUT_MS = 10_000;

interface LiveTeardown {
  settled: boolean;
  failure?: unknown;
  outcome: Promise<{ failure?: unknown }>;
}

interface LiveTeardownGroup {
  generation: number;
  barriers: Set<LiveTeardown>;
  settlementToken?: object;
}

type Reconciliation = 'complete' | 'pending' | 'foreign';

/** Process-generation state keyed by durable claim path; a real restart intentionally resets it. */
const liveTeardowns = new Map<string, LiveTeardownGroup>();
const settlementMutations = new Map<string, Promise<void>>();

/** True only when a durable claim belongs to this already-established publisher authority. */
export function nodeSpawnClaimBelongsToRuntime(
  claim: Pick<NodeSpawnClaim, 'baseUrl' | 'publisherId' | 'publisherName'>,
  runtime: Pick<NodeSpawnRuntime, 'baseUrl' | 'publisher'>,
): boolean {
  return claim.baseUrl === runtime.baseUrl
    && claim.publisherId === runtime.publisher.id
    && claim.publisherName === runtime.publisher.name;
}

export function durableNodeResultDelivery(
  runtime: NodeSpawnRuntime,
  path: string,
  initial: NodeSpawnClaim,
  observed?: NodeResultDelivery,
): NodeResultDelivery {
  const result = initial.result;
  if (result === undefined) throw new NodeSpawnError('Node result settlement requires a durable result');
  if (observed !== undefined && (observed.inboxItemId !== result.inboxItemId
    || observed.messageId !== result.messageId
    || observed.settlementAction !== result.settlementAction)) {
    throw new NodeSpawnError('Observed node result differs from its durable settlement identity',
      'result_identity_mismatch');
  }
  if (observed?.settlementReady !== undefined) {
    rememberLiveTeardown(path, observed.settlementReady);
  }
  let claim = initial;
  let settling: Promise<void> | undefined;
  const settleOnce = (): Promise<void> => serializeSettlementMutation(path, async () => {
    const durable = await loadDurableClaim(path, result);
    const current = durable.result;
    if (current === undefined) throw new NodeSpawnError('Durable node result disappeared before settlement');
    const expected = claim.result?.settlement;
    if (expected === undefined || current.settlement === undefined) {
      throw new NodeSpawnError('Node result cannot settle before its journal intent is durable',
        'result_settlement_unprepared');
    }
    if (current.settlement.attempt !== expected.attempt
      || current.settlement.completionReason !== expected.completionReason) {
      throw new NodeSpawnError('Node result settlement conflicts with its journal identity',
        'result_identity_mismatch');
    }
    if (current.settlement.settledAt !== undefined) {
      if (current.settlement.settledAs !== current.settlementAction) {
        throw new NodeSpawnError('Node result settled with a different inbox action',
          'result_identity_mismatch');
      }
      claim = durable;
      return;
    }
    const liveSettlement = await settleAfterLiveTeardowns(runtime, path, current.settlementAction,
      current.inboxItemId, current.envelope.error ?? 'Relayflows rejected an invalid result');
    const updated: NodeSpawnClaim = { ...durable, result: { ...current, settlement: {
      ...current.settlement,
      settledAt: Date.now(), settledAs: current.settlementAction,
    } } };
    try {
      await recordNodeSpawn(path, updated);
    } catch (error) {
      releaseLiveSettlement(path, liveSettlement);
      throw error;
    }
    claim = updated;
    completeLiveSettlement(path, liveSettlement);
  });
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
    ...(observed?.settlementReady === undefined ? {} : { settlementReady: observed.settlementReady }),
    prepareSettlement: input => serializeSettlementMutation(path, async () => {
      const durable = await loadDurableClaim(path, result);
      const current = durable.result;
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
      if (prior?.settledAt !== undefined && prior.settledAs !== current.settlementAction) {
        throw new NodeSpawnError('Node result settled with a different inbox action',
          'result_identity_mismatch');
      }
      if (prior !== undefined && input.attempt < prior.attempt) {
        throw new NodeSpawnError('Node result settlement cannot move back to an older journal attempt',
          'result_identity_mismatch');
      }
      if (prior !== undefined && prior.attempt === input.attempt) {
        claim = durable;
        return;
      }
      const updated: NodeSpawnClaim = { ...durable, result: { ...current, settlement:
        prior !== undefined && prior.attempt === input.attempt ? prior : {
          attempt: input.attempt,
          completionReason: input.completionReason,
          preparedAt: Date.now(),
        } } };
      await recordNodeSpawn(path, updated);
      claim = updated;
    }),
    ack: settle,
  };
}

async function loadDurableClaim(
  path: string,
  expected: NonNullable<NodeSpawnClaim['result']>,
): Promise<NodeSpawnClaim> {
  const durable = await readNodeSpawnClaim(path);
  const current = durable.result;
  if (current === undefined
    || current.inboxItemId !== expected.inboxItemId
    || current.messageId !== expected.messageId
    || current.status !== expected.status
    || current.settlementAction !== expected.settlementAction) {
    throw new NodeSpawnError('Durable node result differs from its delivery identity',
      'result_identity_mismatch');
  }
  return durable;
}

async function serializeSettlementMutation<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const prior = settlementMutations.get(path) ?? Promise.resolve();
  let release!: () => void;
  const occupied = new Promise<void>(resolve => { release = resolve; });
  const queued = prior.then(() => occupied, () => occupied);
  settlementMutations.set(path, queued);
  await prior.catch(() => undefined);
  try {
    return await mutate();
  } finally {
    release();
    if (settlementMutations.get(path) === queued) settlementMutations.delete(path);
  }
}

/** Reconciles exact cleanup and journaled result settlement left by a crash or failed call. */
export async function reconcileNodeResultSettlements(
  dataDir: string,
  runtime: NodeSpawnRuntime,
  journal: Pick<JournalClient, 'journalRead'>,
): Promise<number> {
  let pending = 0;
  for (const entry of await readNodeSpawnClaims(dataDir)) {
    const status = await serializeSettlementMutation(entry.path,
      () => reconcileNodeResultSettlement(entry.path, runtime, journal));
    if (status === 'pending') pending += 1;
  }
  return pending;
}

async function reconcileNodeResultSettlement(
  path: string,
  runtime: NodeSpawnRuntime,
  journal: Pick<JournalClient, 'journalRead'>,
): Promise<Reconciliation> {
  let claim = await readNodeSpawnClaim(path);
  if (!nodeSpawnClaimBelongsToRuntime(claim, runtime)) {
    return 'foreign';
  }
  if (nodeSpawnCleanupRequired(claim)) {
    const cleanup = await releaseNodeSpawnClaim(runtime, path, claim);
    claim = cleanup.claim;
    if (cleanup.error !== undefined) throw cleanup.error;
  }
  const result = claim.result;
  const settlement = result?.settlement;
  if (result === undefined || settlement === undefined || settlement.settledAt !== undefined) return 'complete';
  const live = liveTeardowns.get(path);
  if (live !== undefined) {
    const failed = [...live.barriers].find(item => item.settled && item.failure !== undefined);
    if (failed !== undefined) throw failed.failure;
    if (live.settlementToken !== undefined || [...live.barriers].some(item => !item.settled)) return 'pending';
  }
  const terminal = await terminalEntry(journal, claim.runId, claim.stepId, settlement.attempt);
  if (terminal === undefined) return 'pending';
  const exact = terminalMatchesResult(terminal, claim, settlement, result);
  const action = exact ? result.settlementAction : 'fail';
  const error = exact ? (result.envelope.error ?? 'Relayflows rejected an invalid result')
    : 'The journal completed this attempt with a different terminal outcome';
  const liveSettlement = await settleAfterLiveTeardowns(
    runtime, path, action, result.inboxItemId, error);
  const updated: NodeSpawnClaim = { ...claim, result: { ...result, settlement: {
    ...settlement, settledAt: Date.now(), settledAs: action,
  } } };
  try {
    await recordNodeSpawn(path, updated);
  } catch (writeError) {
    releaseLiveSettlement(path, liveSettlement);
    throw writeError;
  }
  completeLiveSettlement(path, liveSettlement);
  return 'complete';
}

function rememberLiveTeardown(
  path: string,
  outcome: Promise<{ failure?: unknown }>,
): void {
  const normalized = outcome.then(result => result, failure => ({ failure }));
  const live: LiveTeardown = { settled: false, outcome: normalized };
  let group = liveTeardowns.get(path);
  if (group === undefined) {
    group = { generation: 0, barriers: new Set() };
    liveTeardowns.set(path, group);
  }
  if (group.settlementToken !== undefined) {
    throw new NodeSpawnError('Node result gained a live teardown after settlement started',
      'result_settlement_unconfirmed');
  }
  group.generation += 1;
  group.barriers.add(live);
  void normalized.then(result => {
    live.settled = true;
    live.failure = result.failure;
    if (result.failure === undefined) {
      liveTeardowns.get(path)?.barriers.delete(live);
    }
  });
}

interface LiveSettlement {
  group: LiveTeardownGroup;
  generation: number;
  token: object;
}

async function settleAfterLiveTeardowns(
  runtime: NodeSpawnRuntime,
  path: string,
  action: 'ack' | 'fail',
  inboxItemId: string,
  error: string,
): Promise<LiveSettlement> {
  let active: LiveSettlement | undefined;
  try {
    return await boundedOperation(async signal => {
      for (;;) {
        let group = liveTeardowns.get(path);
        if (group === undefined) {
          group = { generation: 0, barriers: new Set() };
          liveTeardowns.set(path, group);
        }
        if (group.settlementToken !== undefined) {
          throw new NodeSpawnError('Node result settlement is already in progress',
            'result_settlement_unconfirmed');
        }
        const generation = group.generation;
        const outcomes = group.barriers.size === 0
          ? []
          : await Promise.all([...group.barriers].map(item => item.outcome));
        const failed = outcomes.find(item => item.failure !== undefined);
        if (failed?.failure !== undefined) throw failed.failure;
        signal.throwIfAborted();
        const current = liveTeardowns.get(path);
        if (current !== group || current.generation !== generation) continue;
        const token = {};
        current.settlementToken = token;
        active = { group: current, generation, token };
        try {
          await issueInboxSettlement(runtime, action, inboxItemId, error);
          signal.throwIfAborted();
          return active;
        } catch (settlementError) {
          releaseLiveSettlement(path, active);
          throw settlementError;
        }
      }
    });
  } catch (error) {
    if (active !== undefined) releaseLiveSettlement(path, active);
    throw error;
  }
}

function releaseLiveSettlement(path: string, settlement: LiveSettlement): void {
  const current = liveTeardowns.get(path);
  if (current === settlement.group && current.generation === settlement.generation
    && current.settlementToken === settlement.token) {
    current.settlementToken = undefined;
  }
}

function completeLiveSettlement(path: string, settlement: LiveSettlement): void {
  const current = liveTeardowns.get(path);
  if (current === settlement.group && current.generation === settlement.generation
    && current.settlementToken === settlement.token && current.barriers.size === 0) {
    liveTeardowns.delete(path);
  }
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

function issueInboxSettlement(
  runtime: NodeSpawnRuntime,
  action: 'ack' | 'fail',
  inboxItemId: string,
  error: string,
): Promise<unknown> {
  const pending = action === 'ack'
    ? runtime.inbox.inbox.ack({ inboxItemId, state: 'read', metadata: { relayflows_result: 'journaled' } })
    : runtime.inbox.inbox.fail({ inboxItemId, error, retry: false,
      metadata: { relayflows_result: 'rejected' } });
  return pending;
}

async function boundedOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new NodeSpawnError(
        'Node-result inbox settlement did not confirm within its independent deadline',
        'result_settlement_unconfirmed');
      controller.abort(error);
      reject(error);
    }, SETTLEMENT_ATTEMPT_TIMEOUT_MS);
  });
  const pending = operation(controller.signal)
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    const settled = await Promise.race([pending, deadline]);
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
