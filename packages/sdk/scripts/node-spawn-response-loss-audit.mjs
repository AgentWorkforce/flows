#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { walkJournal } from '../dist/journal-reader.js';
import { readNodeSpawnClaims } from '../dist/node-spawn-state.js';
import {
  spawnIdentityDigest,
  verifyResponseLossProxyEvidence,
} from './node-spawn-response-loss-proxy.mjs';

const LOCAL_SCHEMA = 'relayflows-node-spawn-response-loss-local/1';
const DEFERRED_ASSERTIONS = [
  'stored_relaycast_contract_and_capability',
  'provider_frame_and_worker_counts',
  'target_capacity',
  'unrelated_reservation_preservation',
  'remote_fleet_lifecycle',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

function terminalMatchesResult(entry, claim) {
  const result = claim.result;
  const settlement = result?.settlement;
  if (result === undefined || settlement === undefined) return false;
  const payload = record(entry.payload);
  const tail = record(payload.trajectory_tail);
  const relayTask = record(tail.relay_task);
  const execution = record(relayTask.task_execution);
  return entry.entry_type === 'step.completed'
    && entry.step_id === claim.stepId
    && entry.attempt === settlement.attempt
    && payload.completionReason === settlement.completionReason
    && execution.run_id === claim.runId
    && execution.step_id === claim.stepId
    && execution.dispatch_id === claim.idempotencyKey
    && execution.delivery_id === result.inboxItemId
    && execution.message_id === result.messageId;
}

function verifyProcesses(processEvidence) {
  const initial = record(processEvidence?.initial);
  const replays = Array.isArray(processEvidence?.replays) ? processEvidence.replays : [];
  assert(Number.isSafeInteger(initial.pid) && initial.pid > 0,
    'initial process id must be a positive integer');
  assert.equal(initial.code, null, 'the intercepted initial process must not exit normally');
  assert.equal(initial.signal, 'SIGKILL', 'the intercepted initial process must die by SIGKILL');
  assert.equal(replays.length, 2, 'the proof must race exactly two replay processes');
  const replayPids = replays.map(item => record(item).pid);
  assert(replayPids.every(pid => Number.isSafeInteger(pid) && pid > 0),
    'both replay process ids must be positive integers');
  assert.equal(new Set([initial.pid, ...replayPids]).size, 3,
    'initial and replay process generations must be distinct');
  assert(replays.every(item => record(item).signal === null),
    'neither replay process may die by signal');
  const replayExitCodes = replays.map(item => record(item).code);
  assert(replayExitCodes.every(code => Number.isSafeInteger(code) && code >= 0),
    'replay exit codes must be non-negative integers');
  assert(replayExitCodes.includes(0), 'at least one raced replay must complete successfully');
  return {
    initial_pid: initial.pid,
    initial_exit: { code: initial.code, signal: initial.signal },
    replay_pids: replayPids,
    replay_exits: replays.map(item => ({ code: record(item).code, signal: record(item).signal })),
  };
}

/**
 * Verifies only evidence held by the exact Flows data directory and proxy.
 * Server-side dispatch counts, stored Relaycast proofs and fleet state are
 * deliberately outside this local contract.
 */
export function verifyLocalResponseLossEvidence({
  runId,
  claims,
  journalEntries,
  proxyStats,
  processEvidence,
}) {
  assert.equal(typeof runId, 'string');
  const matching = claims.filter(entry => entry.claim?.runId === runId);
  assert.equal(matching.length, 1, 'proof run must have exactly one durable node-spawn claim');
  const claim = matching[0].claim;
  assert.equal(claim.version, 3, 'response-loss proof requires a fenced v3 claim');
  assert(claim.spawn, 'final durable claim must retain its exact spawn identity');
  assert.equal(claim.spawn.action, 'spawn');
  assert.equal(claim.spawn.status, 'completed');
  assert.equal(claim.spawn.spawned, true);
  assert.equal(claim.spawn.ready, true);
  assert.equal(claim.spawn.name, claim.agentName,
    'durable spawn receipt must retain the claimed agent name');
  assert(claim.result, 'final durable claim must retain its correlated result');
  assert.equal(claim.release?.status, 'completed',
    'final durable claim must retain its completed release');
  assert(!Object.hasOwn(claim, 'cleanupPending'),
    'final durable claim must not retain pending cleanup');
  assert(claim.result.settlement, 'final result must retain its journal settlement identity');
  assert.equal(claim.result.settlement.settledAs, claim.result.settlementAction,
    'final result must retain its exact inbox settlement action');
  assert(Number.isSafeInteger(claim.result.settlement.settledAt),
    'final result must retain its settlement time');

  const proxy = verifyResponseLossProxyEvidence(proxyStats);
  const identity = spawnIdentityDigest({
    invocationId: claim.spawn.id,
    nodeId: claim.spawn.nodeId,
    nodeName: claim.spawn.nodeName,
    name: claim.spawn.name,
    agentId: claim.spawn.agentId,
  });
  assert.equal(identity, proxy.spawn_identity_sha256,
    'final durable claim must match the exact intercepted spawn identity');

  const terminals = journalEntries.filter(entry => terminalMatchesResult(entry, claim));
  assert.equal(terminals.length, 1,
    'journal must contain exactly one terminal entry for the correlated result');
  const terminal = terminals[0];
  assert(terminal.at_ms < claim.result.settlement.settledAt,
    'terminal journal entry must precede claim settlement');

  return {
    schema: LOCAL_SCHEMA,
    run_id_sha256: sha256(runId),
    ...proxy,
    final_claim: {
      version: claim.version,
      spawn_identity_sha256: identity,
      result_present: true,
      result_status: claim.result.status,
      release_status: claim.release.status,
      cleanup_pending: false,
      settlement_action: claim.result.settlementAction,
    },
    journal: {
      terminal_sequence: terminal.seq,
      terminal_at_ms: terminal.at_ms,
      settlement_at_ms: claim.result.settlement.settledAt,
      terminal_before_settlement: true,
    },
    process_generations: verifyProcesses(processEvidence),
    deferred_assertions: DEFERRED_ASSERTIONS,
  };
}

export async function auditLocalResponseLoss({
  runId,
  dataDir,
  proxyStatsPath,
  processEvidencePath,
}) {
  for (const [label, path] of [
    ['dataDir', dataDir],
    ['proxyStatsPath', proxyStatsPath],
    ['processEvidencePath', processEvidencePath],
  ]) {
    assert.equal(typeof path, 'string', `${label} is required`);
    assert(isAbsolute(path), `${label} must be absolute`);
  }
  for (const path of [proxyStatsPath, processEvidencePath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600,
      `${path} must be mode 0600`);
  }
  const claims = await readNodeSpawnClaims(dataDir);
  const journalEntries = [];
  for await (const entry of walkJournal(runId, dataDir)) journalEntries.push(entry);
  const proxyStats = JSON.parse(await readFile(proxyStatsPath, 'utf8'));
  const processEvidence = JSON.parse(await readFile(processEvidencePath, 'utf8'));
  return verifyLocalResponseLossEvidence({
    runId, claims, journalEntries, proxyStats, processEvidence,
  });
}

async function main() {
  const value = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const runId = value('--run');
  assert(typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId),
    '--run must be a safe run id');
  assert(process.argv.includes('--json'), 'usage requires --json');
  const dataDir = value('--data-dir');
  const proxyStatsPath = value('--proxy-stats');
  const processEvidencePath = value('--process-evidence');
  assert(typeof dataDir === 'string', '--data-dir is required');
  assert(typeof proxyStatsPath === 'string', '--proxy-stats is required');
  assert(typeof processEvidencePath === 'string', '--process-evidence is required');
  const evidence = await auditLocalResponseLoss({
    runId,
    dataDir: resolve(dataDir),
    proxyStatsPath: resolve(proxyStatsPath),
    processEvidencePath: resolve(processEvidencePath),
  });
  console.log(JSON.stringify(evidence));
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
