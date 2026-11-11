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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function spawnIdentityDigest(identity) {
  for (const field of ['invocationId', 'nodeId', 'nodeName', 'name', 'agentId']) {
    assert.equal(typeof identity?.[field], 'string', `spawn identity ${field} must be a string`);
    assert(identity[field].length > 0, `spawn identity ${field} must not be empty`);
  }
  return sha256(JSON.stringify([
    identity.invocationId,
    identity.nodeId,
    identity.nodeName,
    identity.name,
    identity.agentId,
  ]));
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
          const identity = {
            invocationId: result.id,
            nodeId: result.node_id,
            nodeName: request.params.node_name,
            name: result.name,
            agentId: result.agent_id,
          };
          const event = {
            invocationId: typeof result.id === 'string' ? result.id : undefined,
            spawnIdentityDigest: spawnIdentityDigest(identity),
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

export function verifyResponseLossProxyEvidence(stats) {
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

  return {
    dropped_response_bytes: stats.droppedSpawnReply.responseBytes,
    dropped_response_forwarded_bytes: stats.droppedSpawnReplyForwardedBytes,
    spawn_invoke_calls: stats.methodCounts[SPAWN_INVOKE] ?? 0,
    replay_attempts: stats.spawnInvokeKeys.length - 1,
    unique_spawn_keys: new Set(stats.spawnInvokeKeys).size,
    task_sha256: stats.spawnInvokeTaskDigests[0],
    idempotency_key_sha256: sha256(stats.spawnInvokeKeys[0]),
    spawn_identity_sha256: stats.droppedSpawnReply.spawnIdentityDigest,
    release_calls: stats.methodCounts[SPAWN_RELEASE] ?? 0,
    inbox_settlement_calls: (stats.methodCounts[INBOX_ACK] ?? 0)
      + (stats.methodCounts[INBOX_FAIL] ?? 0),
  };
}
