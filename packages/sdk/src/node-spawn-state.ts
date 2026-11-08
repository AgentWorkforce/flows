import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalize } from './canonical.js';
import type { NodeSpawnReceipt } from './node-spawn.js';

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
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const prior = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!sameClaim(prior, proposed)) throw new Error('Node-spawn dispatch conflicts with its durable identity or input');
    return { claim: prior as NodeSpawnClaim, created: false, path };
  }
  try { await file.writeFile(canonicalize(proposed)); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(directory);
  return { claim: proposed, created: true, path };
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
  const { spawn: _priorSpawn, release: _priorRelease, ...priorIdentity } = prior;
  const { spawn: _spawn, release: _release, ...proposedIdentity } = proposed;
  return canonicalize({ ...priorIdentity, startedAt: proposed.startedAt }) === canonicalize(proposedIdentity);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
