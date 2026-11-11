import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute } from 'node:path';

const NEWLINE = Buffer.from('\n');
const MAX_FRAME_BYTES = 17 * 1024 * 1024;
const SPAWN_INVOKE = 'spawn.invoke';
const SPAWN_RELEASE = 'spawn.release';
const INBOX_ACK = 'spawn_callers.inbox.ack';
const INBOX_FAIL = 'spawn_callers.inbox.fail';
const STRICT_CONTRACT = 'relay.spawn.invoke.logical-replay-resume/1';
const STRICT_REPLAY_CAPABILITY = 'relay.spawn.replay-resume/1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeJson(line) {
  try {
    const value = JSON.parse(line.toString('utf8'));
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function lineReader(onLine, onOverflow) {
  let buffered = Buffer.alloc(0);
  return chunk => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_FRAME_BYTES) {
      onOverflow();
      buffered = Buffer.alloc(0);
      return;
    }
    for (;;) {
      const newline = buffered.indexOf(NEWLINE);
      if (newline < 0) return;
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      onLine(line);
    }
  };
}

/**
 * Transparently proxies Core Bridge JSON-RPC, except for the first successful
 * spawn.invoke reply. That complete reply is read from upstream, recorded by
 * digest, never written downstream, and only then handed to onIntercept so the
 * Flows process can be SIGKILLed before any byte of that reply is delivered.
 */
export async function createBridgeResponseLossProxy({
  listenSocket,
  upstreamSocket,
  onIntercept = () => {},
}) {
  assert(process.platform !== 'win32', 'response-loss proof proxy requires a Unix socket');
  assert(isAbsolute(listenSocket), 'listenSocket must be absolute');
  assert(isAbsolute(upstreamSocket), 'upstreamSocket must be absolute');
  await mkdir(dirname(listenSocket), { recursive: true, mode: 0o700 });
  await chmod(dirname(listenSocket), 0o700);
  await rm(listenSocket, { force: true });

  const sockets = new Set();
  const stats = {
    methodCounts: Object.create(null),
    spawnInvokeTaskDigests: [],
    spawnInvokeKeys: [],
    droppedSpawnReply: undefined,
    droppedSpawnReplyForwardedBytes: 0,
  };
  let interceptedResolve;
  let interceptedReject;
  const intercepted = new Promise((resolveIntercepted, rejectIntercepted) => {
    interceptedResolve = resolveIntercepted;
    interceptedReject = rejectIntercepted;
  });

  const server = net.createServer(downstream => {
    const upstream = net.createConnection(upstreamSocket);
    sockets.add(downstream);
    sockets.add(upstream);
    const pending = new Map();

    const fail = error => {
      if (!stats.droppedSpawnReply) interceptedReject(error);
      downstream.destroy(error);
      upstream.destroy(error);
    };
    const readRequest = lineReader(line => {
      const request = safeJson(line);
      if (typeof request?.id !== 'number' || typeof request.method !== 'string') return;
      const params = typeof request.params === 'object' && request.params !== null
        ? request.params
        : {};
      pending.set(request.id, { method: request.method, params });
      stats.methodCounts[request.method] = (stats.methodCounts[request.method] ?? 0) + 1;
      if (request.method === SPAWN_INVOKE) {
        assert.equal(typeof params.task, 'string', 'spawn.invoke task must be a string');
        assert.equal(typeof params.idempotency_key, 'string', 'spawn.invoke key must be a string');
        stats.spawnInvokeTaskDigests.push(sha256(Buffer.from(params.task, 'utf8')));
        stats.spawnInvokeKeys.push(params.idempotency_key);
      }
    }, () => fail(new Error('Core Bridge request frame exceeded proof proxy limit')));

    downstream.on('data', chunk => {
      try {
        readRequest(chunk);
        upstream.write(chunk);
      } catch (error) {
        fail(error);
      }
    });

    const readReply = lineReader(line => {
      try {
        const reply = safeJson(line);
        const request = typeof reply?.id === 'number' ? pending.get(reply.id) : undefined;
        if (typeof reply?.id === 'number') pending.delete(reply.id);
        if (!stats.droppedSpawnReply && request?.method === SPAWN_INVOKE && !reply?.error) {
          const result = typeof reply?.result === 'object' && reply.result !== null ? reply.result : {};
          const event = {
            invocationId: typeof result.id === 'string' ? result.id : undefined,
            responseDigest: sha256(Buffer.concat([line, NEWLINE])),
            responseBytes: line.length + 1,
          };
          stats.droppedSpawnReply = event;
          // The callback issues SIGKILL synchronously. The response remains in
          // this proxy and the downstream is closed without a write.
          onIntercept(event);
          interceptedResolve(event);
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(Buffer.concat([line, NEWLINE]));
      } catch (error) {
        fail(error);
      }
    }, () => fail(new Error('Core Bridge reply frame exceeded proof proxy limit')));

    upstream.on('data', readReply);
    upstream.on('error', fail);
    downstream.on('error', error => upstream.destroy(error));
    downstream.on('close', () => {
      sockets.delete(downstream);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(listenSocket, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  await chmod(listenSocket, 0o600);

  return {
    stats,
    intercepted,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolveClose => server.close(() => resolveClose()));
      await rm(listenSocket, { force: true });
    },
  };
}

export function verifyResponseLossEvidence(stats, audit) {
  assert.equal(stats.droppedSpawnReplyForwardedBytes, 0,
    'no byte of the committed spawn.invoke reply may reach Flows');
  assert(stats.droppedSpawnReply, 'the proxy must drop one successful spawn.invoke reply');
  assert(stats.spawnInvokeTaskDigests.length >= 2,
    'the committed invoke and at least one same-key replay must cross the proxy');
  assert.equal(stats.spawnInvokeTaskDigests.length, stats.spawnInvokeKeys.length);
  assert.equal(new Set(stats.spawnInvokeTaskDigests).size, 1,
    'every same-key retry must preserve the original task bytes');
  assert.equal(new Set(stats.spawnInvokeKeys).size, 1,
    'every retry must use the original idempotency key');
  assert.equal(stats.methodCounts[SPAWN_RELEASE] ?? 0, 1,
    'Flows must issue exactly one release through the bridge');
  assert.equal((stats.methodCounts[INBOX_ACK] ?? 0) + (stats.methodCounts[INBOX_FAIL] ?? 0), 1,
    'Flows must settle the correlated inbox item exactly once');

  assert.equal(audit.schema, 'relayflows-node-spawn-response-loss/1');
  assert.equal(audit.strict_contract, STRICT_CONTRACT);
  assert.equal(audit.strict_replay_capability, STRICT_REPLAY_CAPABILITY);
  assert.equal(audit.strict_invocation_committed, true);
  assert.equal(audit.upstream_spawn_frames, 1);
  assert.equal(audit.workers_created, 1);
  assert.equal(audit.correlated_results, 1);
  assert.equal(audit.releases, 1);
  assert.equal(audit.final_claim?.result_present, true,
    'the final durable claim must retain its correlated result');
  assert.equal(audit.final_claim?.release_confirmed, true,
    'the final durable claim must retain its confirmed release');
  assert.equal(audit.final_claim?.cleanup_pending, false,
    'the final durable claim must not retain pending cleanup');
  assert.equal(audit.target_capacity?.active_agents, 0);
  assert.equal(audit.target_capacity?.reserved_agents, 0);
  assert.equal(typeof audit.journal_terminal_sequence, 'number');
  assert.equal(typeof audit.inbox_settlement_sequence, 'number');
  assert(audit.journal_terminal_sequence < audit.inbox_settlement_sequence,
    'terminal journal evidence must precede inbox settlement');
  assert.equal(typeof audit.unrelated_reservation?.before?.identity, 'string');
  assert.equal(typeof audit.unrelated_reservation?.before?.count, 'number');
  assert.deepEqual(audit.unrelated_reservation.after, audit.unrelated_reservation.before,
    'the unrelated reservation must remain unchanged');
  return {
    schema: audit.schema,
    strict_contract: audit.strict_contract,
    strict_replay_capability: audit.strict_replay_capability,
    strict_invocation_committed: audit.strict_invocation_committed,
    dropped_response_bytes: stats.droppedSpawnReply.responseBytes,
    dropped_response_forwarded_bytes: stats.droppedSpawnReplyForwardedBytes,
    spawn_invoke_calls: stats.methodCounts[SPAWN_INVOKE] ?? 0,
    task_sha256: stats.spawnInvokeTaskDigests[0],
    idempotency_key_sha256: sha256(stats.spawnInvokeKeys[0]),
    upstream_spawn_frames: audit.upstream_spawn_frames,
    workers_created: audit.workers_created,
    correlated_results: audit.correlated_results,
    releases: audit.releases,
    final_claim: audit.final_claim,
    target_capacity: audit.target_capacity,
    unrelated_reservation: audit.unrelated_reservation,
    journal_terminal_sequence: audit.journal_terminal_sequence,
    inbox_settlement_sequence: audit.inbox_settlement_sequence,
  };
}
