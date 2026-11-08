import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalize } from './canonical.js';
import type { NodeSpawnIdentity, NodeSpawnReceipt } from './node-spawn.js';

export interface NodeSpawnClaim {
  version: 2;
  baseUrl: string;
  publisherId: string;
  publisherName: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  agentName: string;
  request: Record<string, unknown>;
  startedAt: number;
  spawn?: NodeSpawnReceipt;
  cleanup?: NodeSpawnIdentity;
  failure?: { code: string; message: string };
  result?: { inboxItemId: string; messageId: string; status: 'completed' | 'failed'; receivedAt: number };
  cleanupPending?: { attempts: number; lastError: string; updatedAt: number };
  release?: { invocationId: string; status: string };
}

export async function claimNodeSpawn(dataDir: string, proposed: NodeSpawnClaim): Promise<{
  claim: NodeSpawnClaim; created: boolean; path: string;
}> {
  const directory = join(dataDir, 'node-spawns');
  await mkdir(directory, { recursive: true });
  await syncDirectory(dataDir);
  const digest = createHash('sha256')
    .update(canonicalize([proposed.runId, proposed.stepId, proposed.idempotencyKey]))
    .digest('hex');
  const path = join(directory, `${digest}.json`);
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
    const prior = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!sameClaim(prior, proposed)) throw new Error('Node-spawn dispatch conflicts with its durable identity or input');
    return { claim: prior as NodeSpawnClaim, created: false, path };
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

function sameClaim(value: unknown, proposed: NodeSpawnClaim): boolean {
  if (typeof value !== 'object' || value === null || !('startedAt' in value)
    || typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt)) return false;
  const prior = value as NodeSpawnClaim;
  const { spawn: _priorSpawn, cleanup: _priorCleanup, failure: _priorFailure,
    result: _priorResult, cleanupPending: _priorCleanupPending,
    release: _priorRelease, ...priorIdentity } = prior;
  const { spawn: _spawn, cleanup: _cleanup, failure: _failure, result: _result,
    cleanupPending: _cleanupPending, release: _release, ...proposedIdentity } = proposed;
  return canonicalize({ ...priorIdentity, startedAt: proposed.startedAt }) === canonicalize(proposedIdentity);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
