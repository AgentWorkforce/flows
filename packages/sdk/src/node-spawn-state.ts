import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalize } from './canonical.js';
import { readNodeResult, type NodeResultEnvelope } from './node-spawn-result.js';
import { isRecord, nonempty, validIdempotencyKey, validNodeSpawnIdentity, validNodeSpawnReceipt,
  type NodeSpawnIdentity, type NodeSpawnReceipt } from './node-spawn.js';

export interface NodeSpawnClaim {
  version: 2;
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
  const { spawn: _priorSpawn, cleanup: _priorCleanup, failure: _priorFailure,
    result: _priorResult, cleanupPending: _priorCleanupPending,
    release: _priorRelease, ...priorIdentity } = prior;
  const { spawn: _spawn, cleanup: _cleanup, failure: _failure, result: _result,
    cleanupPending: _cleanupPending, release: _release, ...proposedIdentity } = proposed;
  return canonicalize({ ...priorIdentity, startedAt: proposed.startedAt }) === canonicalize(proposedIdentity);
}

function decodeNodeSpawnClaim(value: unknown, label: string): NodeSpawnClaim {
  const invalid = (): never => { throw new Error(`Invalid durable node-spawn claim: ${label}`); };
  const record = isRecord(value) ? value : invalid();
  if (record.version !== 2
    || ![record.baseUrl, record.publisherId, record.publisherName, record.runId, record.stepId, record.agentName]
      .every(nonempty)
    || !validIdempotencyKey(record.idempotencyKey)
    || !positiveInteger(record.timeoutMs) || record.timeoutMs > 86_400_000
    || !isRecord(record.request)
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

const safeTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
