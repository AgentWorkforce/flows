import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalize } from './canonical.js';
import { readNodeResult, type NodeResultEnvelope } from './node-spawn-result.js';
import { isRecord, nonempty, validIdempotencyKey, validNodeSpawnIdentity, validNodeSpawnReceipt,
  type NodeSpawnIdentity, type NodeSpawnReceipt } from './node-spawn.js';

export interface NodeSpawnClaim {
  version: 2 | 3;
  baseUrl: string;
  publisherId: string;
  publisherName: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  agentName: string;
  timeoutMs: number;
  request: Record<string, unknown>;
  startedAt: number;
  spawn?: NodeSpawnReceipt;
  cleanup?: NodeSpawnIdentity;
  failure?: { code: string; message: string };
  result?: { inboxItemId: string; messageId: string; status: 'completed' | 'failed';
    envelope: NodeResultEnvelope; settlementAction: 'ack' | 'fail'; receivedAt: number;
    settlement?: { attempt: number; completionReason: string; preparedAt: number;
      settledAt?: number; settledAs?: 'ack' | 'fail' } };
  cleanupPending?: { attempts: number; lastError: string; updatedAt: number };
  release?: { invocationId: string; status: string };
}

interface NodeSpawnDispatchFence {
  version: 1;
  claimDigest: string;
}

/** A durable write-ahead fence already owns the only permitted dispatch. */
export class NodeSpawnDispatchFencedError extends Error {
  constructor() {
    super('A prior node-spawn dispatch entered the ambiguous pre-ack window; refusing a second spawn');
    this.name = 'NodeSpawnDispatchFencedError';
  }
}

export async function claimNodeSpawn(dataDir: string, proposed: NodeSpawnClaim): Promise<{
  claim: NodeSpawnClaim; created: boolean; path: string;
}> {
  const path = await nodeSpawnClaimPath(
    dataDir, proposed.runId, proposed.stepId, proposed.idempotencyKey);
  return claimNodeSpawnAtPath(path, proposed);
}

export async function claimNodeSpawnAtPath(path: string, proposed: NodeSpawnClaim): Promise<{
  claim: NodeSpawnClaim; created: boolean; path: string;
}> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  await syncDirectory(dirname(directory));
  const digest = basename(path, '.json');
  const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(canonicalize(proposed)); await file.sync(); }
  finally { await file.close(); }
  try {
    // A hard link publishes the already-complete inode atomically and refuses
    // to replace a claim won by another worker.
    await link(temporary, path);
    await syncDirectory(directory);
    return { claim: proposed, created: true, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const prior = decodeNodeSpawnClaim(JSON.parse(await readFile(path, 'utf8')) as unknown, path);
    if (!sameClaim(prior, proposed)) throw new Error('Node-spawn dispatch conflicts with its durable identity or input');
    return { claim: prior, created: false, path };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function nodeSpawnClaimPath(
  dataDir: string,
  runId: string,
  stepId: string,
  idempotencyKey: string,
): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const canonicalDataDir = await realpath(dataDir);
  const digest = createHash('sha256')
    .update(canonicalize([runId, stepId, idempotencyKey]))
    .digest('hex');
  return join(canonicalDataDir, 'node-spawns', `${digest}.json`);
}

export function nodeSpawnDispatchFencePath(claimPath: string): string {
  return `${claimPath}.dispatch`;
}

/** Reads and validates the one-way dispatch fence for a v3 claim. */
export async function hasNodeSpawnDispatchFence(
  claimPath: string,
  claim: NodeSpawnClaim,
): Promise<boolean> {
  const fencePath = nodeSpawnDispatchFencePath(claimPath);
  let text: string;
  try { text = await readFile(fencePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw invalidDispatchFence(fencePath, error);
  }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (error) { throw invalidDispatchFence(fencePath, error); }
  decodeDispatchFence(value, fencePath, claim);
  return true;
}

/**
 * Atomically publishes the write-ahead fact immediately before dispatch.
 * The marker is permanent: a crash after it is indistinguishable from a sent
 * request, so no later worker may publish or dispatch again.
 */
export async function claimNodeSpawnDispatch(
  claimPath: string,
  claim: NodeSpawnClaim,
): Promise<void> {
  if (claim.version !== 3) throw new Error('Legacy node-spawn claims cannot enter the fenced dispatch protocol');
  const fencePath = nodeSpawnDispatchFencePath(claimPath);
  const directory = dirname(fencePath);
  const temporary = `${fencePath}.${randomUUID()}.tmp`;
  const fence: NodeSpawnDispatchFence = {
    version: 1,
    claimDigest: dispatchClaimDigest(claim),
  };
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(canonicalize(fence)); await file.sync(); }
    finally { await file.close(); }
    try {
      await link(temporary, fencePath);
      await syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await hasNodeSpawnDispatchFence(claimPath, claim);
      throw new NodeSpawnDispatchFencedError();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function recordNodeSpawn(path: string, claim: NodeSpawnClaim): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(canonicalize(claim)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function readNodeSpawnClaims(dataDir: string): Promise<Array<{ path: string; claim: NodeSpawnClaim }>> {
  let canonicalDataDir: string;
  try { canonicalDataDir = await realpath(dataDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const directory = join(canonicalDataDir, 'node-spawns');
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const claims: Array<{ path: string; claim: NodeSpawnClaim }> = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(directory, name);
    claims.push({ path, claim: await readNodeSpawnClaim(path) });
  }
  return claims;
}

export async function readNodeSpawnClaim(path: string): Promise<NodeSpawnClaim> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return decodeNodeSpawnClaim(value, path);
}

function sameClaim(prior: NodeSpawnClaim, proposed: NodeSpawnClaim): boolean {
  const { version: _priorVersion,
    spawn: _priorSpawn, cleanup: _priorCleanup, failure: _priorFailure,
    result: _priorResult, cleanupPending: _priorCleanupPending,
    release: _priorRelease, ...priorIdentity } = prior;
  const { version: _version,
    spawn: _spawn, cleanup: _cleanup, failure: _failure, result: _result,
    cleanupPending: _cleanupPending, release: _release, ...proposedIdentity } = proposed;
  const { task: _priorRenderedTask, ...priorRequestIdentity } = priorIdentity.request;
  const { task: _renderedTask, ...proposedRequestIdentity } = proposedIdentity.request;
  return canonicalize({ ...priorIdentity, version: proposed.version, request: priorRequestIdentity,
    startedAt: proposed.startedAt }) === canonicalize({
    ...proposedIdentity, version: proposed.version, request: proposedRequestIdentity,
  });
}

function decodeNodeSpawnClaim(value: unknown, label: string): NodeSpawnClaim {
  const invalid = (): never => { throw new Error(`Invalid durable node-spawn claim: ${label}`); };
  const record = isRecord(value) ? value : invalid();
  if ((record.version !== 2 && record.version !== 3)
    || ![record.baseUrl, record.publisherId, record.publisherName, record.runId, record.stepId, record.agentName]
      .every(nonempty)
    || !validIdempotencyKey(record.idempotencyKey)
    || !positiveInteger(record.timeoutMs) || record.timeoutMs > 86_400_000
    || !isRecord(record.request)
    || ![record.request.cli, record.request.task, record.request.task_identity].every(nonempty)
    || !safeTime(record.startedAt)) invalid();
  const claim = record as unknown as NodeSpawnClaim;
  if (record.spawn !== undefined && !validNodeSpawnReceipt(record.spawn)) invalid();
  if (record.cleanup !== undefined && !validNodeSpawnIdentity(record.cleanup)) invalid();
  if (record.spawn !== undefined && record.cleanup !== undefined) invalid();
  if (record.failure !== undefined) {
    const failure = isRecord(record.failure) ? record.failure : invalid();
    if (!nonempty(failure.code) || !nonempty(failure.message)
      || (record.spawn === undefined && record.cleanup === undefined)) invalid();
  }
  if (record.cleanupPending !== undefined) {
    const pending = isRecord(record.cleanupPending) ? record.cleanupPending : invalid();
    if (!positiveInteger(pending.attempts) || !nonempty(pending.lastError) || !safeTime(pending.updatedAt)
      || (record.spawn === undefined && record.cleanup === undefined) || record.release !== undefined) invalid();
  }
  if (record.release !== undefined) {
    const release = isRecord(record.release) ? record.release : invalid();
    if (!nonempty(release.invocationId) || release.status !== 'completed'
      || (record.spawn === undefined && record.cleanup === undefined)) invalid();
  }
  if (record.result !== undefined) {
    const result = isRecord(record.result) ? record.result : invalid();
    if (!nonempty(result.inboxItemId)
      || !nonempty(result.messageId)
      || !['completed', 'failed'].includes(String(result.status))
      || !['ack', 'fail'].includes(String(result.settlementAction))
      || !safeTime(result.receivedAt)) invalid();
    let envelope: NodeResultEnvelope;
    try {
      envelope = readNodeResult(result.envelope, {
        runId: claim.runId, stepId: claim.stepId, dispatchId: claim.idempotencyKey,
      });
    } catch { invalid(); }
    if (envelope!.status !== result.status || record.spawn === undefined) invalid();
    const settlement = result.settlement;
    if (settlement !== undefined) {
      if (!isRecord(settlement) || !positiveInteger(settlement.attempt)
        || !nonempty(settlement.completionReason) || !safeTime(settlement.preparedAt)
        || (settlement.settledAt !== undefined && !safeTime(settlement.settledAt))
        || (settlement.settledAs !== undefined && !['ack', 'fail'].includes(String(settlement.settledAs)))
        || (settlement.settledAt === undefined) !== (settlement.settledAs === undefined)) invalid();
    }
  }
  return claim;
}

function dispatchClaimDigest(claim: NodeSpawnClaim): string {
  const { spawn: _spawn, cleanup: _cleanup, failure: _failure,
    result: _result, cleanupPending: _cleanupPending, release: _release,
    ...identity } = claim;
  return createHash('sha256').update(canonicalize(identity)).digest('hex');
}

function decodeDispatchFence(value: unknown, label: string, claim: NodeSpawnClaim): NodeSpawnDispatchFence {
  const record = isRecord(value) ? value : undefined;
  if (record?.version !== 1
    || typeof record.claimDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.claimDigest)
    || record.claimDigest !== dispatchClaimDigest(claim)) {
    throw invalidDispatchFence(label);
  }
  return record as unknown as NodeSpawnDispatchFence;
}

function invalidDispatchFence(label: string, cause?: unknown): Error {
  return new Error(`Invalid durable node-spawn dispatch fence: ${label}`, { cause });
}

const safeTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
