import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

interface ProxyStats {
  methodCounts: Record<string, number>;
  spawnInvokeTaskDigests: string[];
  spawnInvokeKeys: string[];
  droppedSpawnReply?: {
    invocationId?: string;
    spawnIdentityDigest: string;
    responseDigest: string;
    responseBytes: number;
  };
  droppedSpawnReplyForwardedBytes: number;
}

interface ProofProxy {
  stats: ProxyStats;
  intercepted: Promise<unknown>;
  close(): Promise<void>;
}

interface ProxyModule {
  createBridgeResponseLossProxy(options: {
    listenSocket: string;
    upstreamSocket: string;
    onIntercept?: () => void;
  }): Promise<ProofProxy>;
  spawnIdentityDigest(identity: Record<string, string>): string;
  verifyResponseLossProxyEvidence(stats: ProxyStats): Record<string, unknown>;
}

const moduleUrl = new URL('../scripts/node-spawn-response-loss-proxy.mjs', import.meta.url).href;
const runnerModuleUrl = new URL('../scripts/node-spawn-response-loss-e2e.mjs', import.meta.url).href;
const auditModuleUrl = new URL('../scripts/node-spawn-response-loss-audit.mjs', import.meta.url).href;
const roots: string[] = [];
const servers: net.Server[] = [];
const proxies: ProofProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function lineServer(socket: string) {
  const keys = new Set<string>();
  let upstreamSpawnFrames = 0;
  const server = net.createServer(connection => {
    let buffered = '';
    connection.on('data', chunk => {
      buffered += String(chunk);
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const request = JSON.parse(line) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (request.method === 'spawn.invoke') {
          const key = String(request.params?.['idempotency_key']);
          if (!keys.has(key)) {
            keys.add(key);
            upstreamSpawnFrames += 1;
          }
          connection.write(`${JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            result: {
              id: 'invocation-1', agent_id: 'agent-1', status: 'completed',
              node_id: 'node-1', name: 'worker-1', spawned: true, ready: true,
              released: false, task_unconfirmed: false, error_code: null,
            },
          })}\n`);
        } else {
          connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })}\n`);
        }
      }
    });
  });
  server.listen(socket);
  servers.push(server);
  return { server, upstreamSpawnFrames: () => upstreamSpawnFrames };
}

async function request(socket: string, value: unknown): Promise<{ bytes: number; reply?: unknown }> {
  const client = net.createConnection(socket);
  await once(client, 'connect');
  let buffered = '';
  let bytes = 0;
  const reply = new Promise<unknown | undefined>(resolveReply => {
    client.on('data', chunk => {
      bytes += chunk.length;
      buffered += String(chunk);
      const newline = buffered.indexOf('\n');
      if (newline >= 0) resolveReply(JSON.parse(buffered.slice(0, newline)));
    });
    client.once('close', () => resolveReply(undefined));
  });
  client.write(`${JSON.stringify(value)}\n`);
  const answer = await reply;
  client.destroy();
  return { bytes, reply: answer };
}

async function run(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

async function localEvidenceFixture() {
  const proxy = await import(moduleUrl) as ProxyModule;
  const identity = {
    invocationId: 'invocation-1', nodeId: 'node-1', nodeName: 'desktop-1',
    name: 'worker-1', agentId: 'agent-1',
  };
  const key = 'a'.repeat(32);
  return {
    runId: 'run_fixture',
    claims: [{ path: '/private/claim.json', claim: {
      version: 3,
      baseUrl: 'https://cast.agentrelay.com', publisherId: 'publisher-1',
      publisherName: 'flows-e2e', runId: 'run_fixture', stepId: 'step-1',
      idempotencyKey: key, agentName: 'worker-1', timeoutMs: 600000,
      request: { cli: 'codex', task: 'task', task_identity: 'task' }, startedAt: 1,
      spawn: { id: identity.invocationId, action: 'spawn', status: 'completed',
        nodeId: identity.nodeId, nodeName: identity.nodeName, name: identity.name,
        agentId: identity.agentId, spawned: true, ready: true },
      result: { inboxItemId: 'item-1', messageId: 'message-1', status: 'completed',
        envelope: { version: 1, run_id: 'run_fixture', step_id: 'step-1',
          dispatch_id: key, status: 'completed', output: { ok: true } },
        settlementAction: 'ack', receivedAt: 150,
        settlement: { attempt: 1, completionReason: 'success', preparedAt: 175,
          settledAt: 200, settledAs: 'ack' } },
      release: { invocationId: 'release-1', status: 'completed' },
    } }],
    journalEntries: [{ seq: 10, segment_id: 1, entry_type: 'step.completed',
      run_id: 'run_fixture', step_id: 'step-1', attempt: 1, at_ms: 100,
      payload: { completionReason: 'success', trajectory_tail: { relay_task: {
        task_execution: { run_id: 'run_fixture', step_id: 'step-1', dispatch_id: key,
          delivery_id: 'item-1', message_id: 'message-1' },
      } } } }],
    proxyStats: {
      methodCounts: { 'spawn.invoke': 2, 'spawn.release': 1, 'spawn_callers.inbox.ack': 1 },
      spawnInvokeTaskDigests: ['task-digest', 'task-digest'],
      spawnInvokeKeys: [key, key],
      droppedSpawnReply: { invocationId: identity.invocationId,
        spawnIdentityDigest: proxy.spawnIdentityDigest(identity),
        responseDigest: 'response-digest', responseBytes: 64 },
      droppedSpawnReplyForwardedBytes: 0,
    },
    processEvidence: {
      initial: { pid: 101, code: null, signal: 'SIGKILL' },
      replays: [{ pid: 102, code: 0, signal: null }, { pid: 103, code: 3, signal: null }],
    },
  };
}

describe('Core Bridge response-loss proof proxy', () => {
  it('drops every byte of the committed reply and lets two same-key replays converge on one frame', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flows-response-loss-proxy-'));
    roots.push(root);
    const upstreamSocket = join(root, 'upstream.sock');
    const proxySocket = join(root, 'proxy.sock');
    const upstream = lineServer(upstreamSocket);
    await once(upstream.server, 'listening');
    let intercepted = 0;
    const module = await import(moduleUrl) as ProxyModule;
    const proxy = await module.createBridgeResponseLossProxy({
      listenSocket: proxySocket,
      upstreamSocket,
      onIntercept: () => { intercepted += 1; },
    });
    proxies.push(proxy);
    const spawn = {
      jsonrpc: '2.0', id: 1, method: 'spawn.invoke',
      params: {
        idempotency_key: 'a'.repeat(32), task: 'exact original task bytes',
        node_id: 'node-1', node_name: 'desktop-1', name: 'worker-1',
      },
    };

    const first = await request(proxySocket, spawn);
    await proxy.intercepted;
    expect(first).toEqual({ bytes: 0, reply: undefined });
    expect(intercepted).toBe(1);

    const [left, right] = await Promise.all([
      request(proxySocket, spawn),
      request(proxySocket, spawn),
    ]);
    expect(left.reply).toMatchObject({ result: { id: 'invocation-1' } });
    expect(right.reply).toMatchObject({ result: { id: 'invocation-1' } });
    expect(upstream.upstreamSpawnFrames()).toBe(1);

    await request(proxySocket, { jsonrpc: '2.0', id: 2, method: 'spawn.release', params: {} });
    await request(proxySocket, { jsonrpc: '2.0', id: 3, method: 'spawn_callers.inbox.ack', params: {} });
    expect(module.verifyResponseLossProxyEvidence(proxy.stats)).toMatchObject({
      dropped_response_forwarded_bytes: 0,
      spawn_invoke_calls: 3,
      replay_attempts: 2,
      unique_spawn_keys: 1,
      release_calls: 1,
      inbox_settlement_calls: 1,
    });
  });

  it('rejects changed task bytes even when the fixture reports a clean lifecycle', async () => {
    const module = await import(moduleUrl) as ProxyModule;
    const stats: ProxyStats = {
      methodCounts: { 'spawn.invoke': 3, 'spawn.release': 1, 'spawn_callers.inbox.ack': 1 },
      spawnInvokeTaskDigests: ['one', 'two', 'two'],
      spawnInvokeKeys: ['key', 'key', 'key'],
      droppedSpawnReply: { spawnIdentityDigest: 'identity', responseDigest: 'reply', responseBytes: 12 },
      droppedSpawnReplyForwardedBytes: 0,
    };
    expect(() => module.verifyResponseLossProxyEvidence(stats)).toThrow('original task bytes');
  });

  it('fails closed when the final claim or journal ordering is not durable', async () => {
    const audit = await import(auditModuleUrl) as {
      verifyLocalResponseLossEvidence(input: Record<string, unknown>): Record<string, unknown>;
    };
    const fixture = await localEvidenceFixture();
    expect(audit.verifyLocalResponseLossEvidence(fixture)).toMatchObject({
      schema: 'relayflows-node-spawn-response-loss-local/1',
      final_claim: { result_present: true, release_status: 'completed', cleanup_pending: false },
      journal: { terminal_before_settlement: true },
    });
    const missingResult = structuredClone(fixture);
    delete missingResult.claims[0].claim.result;
    expect(() => audit.verifyLocalResponseLossEvidence(missingResult))
      .toThrow('retain its correlated result');
    const settledBeforeJournal = structuredClone(fixture);
    settledBeforeJournal.claims[0].claim.result.settlement.settledAt = 50;
    expect(() => audit.verifyLocalResponseLossEvidence(settledBeforeJournal))
      .toThrow('precede claim settlement');
  });

  it('rejects ar_ credentials in captured proof logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flows-response-loss-secret-'));
    roots.push(root);
    const log = join(root, 'resume.log');
    writeFileSync(log, `unexpected credential ar_${'A'.repeat(24)}\n`, { mode: 0o600 });
    const runner = await import(runnerModuleUrl) as {
      assertSecretFree(paths: string[]): Promise<void>;
    };
    await expect(runner.assertSecretFree([log])).rejects.toThrow('credential-shaped material');
  });

  it('uses the default timeout for killed-child and two-resume acceptance orchestration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flows-response-loss-runner-'));
    roots.push(root);
    const upstreamSocket = join(root, 'upstream.sock');
    const upstream = lineServer(upstreamSocket);
    await once(upstream.server, 'listening');
    const dataDir = join(root, 'data');
    const evidenceDir = join(root, 'evidence');
    const homeDir = join(root, 'home');
    const workDir = join(root, 'work');
    mkdirSync(workDir, { recursive: true });
    const callerFile = join(root, 'caller.json');
    writeFileSync(callerFile, `${JSON.stringify({
      schema: 'agent-relay-service-caller/2',
      auth: {
        scheme: 'challenge-hmac-sha256/v1',
        challenge: 'spawn_callers.challenge',
        authenticate: 'spawn_callers.authenticate',
      },
      caller_id: 'sc_0123456789abcdef',
      caller_name: 'flows_e2e',
      secret: `rsc_${'A'.repeat(43)}`,
      publisher: { id: 'publisher_1', name: 'flows_e2e' },
      workspace: {
        site_url: 'https://agentrelay.com',
        base_url: 'https://cast.agentrelay.com',
        workspace_id: 'workspace_1',
        relaycast_workspace_id: 'relaycast_1',
      },
      account: { user_id: 'user_1' },
      created_at: '2026-11-01T00:00:00.000Z',
      expires_at: '2026-12-01T00:00:00.000Z',
      harnesses: ['codex'],
      directory_scope: [workDir],
      owns_only: true,
      socket: upstreamSocket,
      inbox: {
        transport: 'core-bridge',
        open: 'spawn_callers.inbox.open',
        next: 'spawn_callers.inbox.next',
        ack: 'spawn_callers.inbox.ack',
        fail: 'spawn_callers.inbox.fail',
        close: 'spawn_callers.inbox.close',
        disconnect: 'spawn_callers.disconnect',
      },
      desktop_version: 'fixture',
    })}\n`, { mode: 0o600 });
    chmodSync(callerFile, 0o600);

    const childScript = join(root, 'fake-flows.mjs');
    writeFileSync(childScript, `
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [mode, dataDir, winner] = process.argv.slice(2);
const runId = 'run_fixture';
const stepId = 'step_fixture';
const key = 'a'.repeat(32);
const caller = JSON.parse(readFileSync(process.env.RELAYFLOW_SERVICE_CALLER_FILE, 'utf8'));
const rpc = (method, id) => new Promise((resolve, reject) => {
  const socket = net.createConnection(caller.socket);
  let buffered = '';
  socket.once('error', reject);
  socket.once('connect', () => socket.write(JSON.stringify({
    jsonrpc: '2.0', id, method, params: method === 'spawn.invoke'
      ? { idempotency_key: key, task: 'exact original task bytes',
          node_id: 'node-1', node_name: 'desktop-1', name: 'worker-1' }
      : {},
  }) + '\\n'));
  socket.on('data', chunk => {
    buffered += String(chunk);
    const newline = buffered.indexOf('\\n');
    if (newline < 0) return;
    socket.destroy();
    resolve(JSON.parse(buffered.slice(0, newline)));
  });
});
if (mode === 'start') {
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'runs', runId + '.sqlite3'));
  db.exec(\`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO meta VALUES ('run_id', 'run_fixture'), ('journal_version', '1');
    CREATE TABLE segments (segment_id INTEGER PRIMARY KEY, journal_version INTEGER NOT NULL, opened_seq INTEGER NOT NULL);
    INSERT INTO segments VALUES (1, 1, 1);
    CREATE TABLE entries (seq INTEGER PRIMARY KEY, segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
      entry_type TEXT NOT NULL, step_id TEXT, attempt INTEGER, at_ms INTEGER NOT NULL, payload TEXT NOT NULL);
  \`);
  db.close();
  await rpc('spawn.invoke', 1);
  process.exit(99);
}
let won = false;
try { closeSync(openSync(winner, 'wx')); won = true; } catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
if (!won) process.exit(3);
await rpc('spawn.invoke', 1);
await rpc('spawn.release', 2);
await rpc('spawn_callers.inbox.ack', 3);
const journal = new DatabaseSync(join(dataDir, 'runs', runId + '.sqlite3'));
journal.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  10, 1, 'step.completed', stepId, 1, 100, JSON.stringify({
    completionReason: 'success',
    trajectory_tail: { relay_task: { task_execution: {
      run_id: runId, step_id: stepId, dispatch_id: key,
      delivery_id: 'item-1', message_id: 'message-1',
    } } },
  }),
);
journal.close();
const claim = {
  version: 3,
  baseUrl: 'https://cast.agentrelay.com',
  publisherId: 'publisher-1',
  publisherName: 'flows-e2e',
  runId,
  stepId,
  idempotencyKey: key,
  agentName: 'worker-1',
  timeoutMs: 600000,
  request: { cli: 'codex', task: 'exact original task bytes', task_identity: 'proof-task' },
  startedAt: 1,
  spawn: {
    id: 'invocation-1', action: 'spawn', status: 'completed',
    nodeId: 'node-1', nodeName: 'desktop-1', name: 'worker-1', agentId: 'agent-1',
    spawned: true, ready: true,
  },
  result: {
    inboxItemId: 'item-1', messageId: 'message-1', status: 'completed',
    envelope: { version: 1, run_id: runId, step_id: stepId, dispatch_id: key,
      status: 'completed', output: { ok: true } },
    settlementAction: 'ack', receivedAt: 150,
    settlement: { attempt: 1, completionReason: 'success', preparedAt: 175,
      settledAt: 200, settledAs: 'ack' },
  },
  release: { invocationId: 'release-1', status: 'completed' },
};
mkdirSync(join(dataDir, 'node-spawns'), { recursive: true });
writeFileSync(join(dataDir, 'node-spawns', 'b'.repeat(64) + '.json'), JSON.stringify(claim), { mode: 0o600 });
`);
    const config = join(root, 'config.json');
    writeFileSync(config, `${JSON.stringify({
      callerFile,
      dataDir,
      evidenceDir,
      homeDir,
      workDir,
      start: { command: process.execPath, args: [childScript, 'start', dataDir, join(root, 'winner')] },
      resume: { command: process.execPath, args: [childScript, 'resume', dataDir, join(root, 'winner'), '{RUN_ID}'] },
    })}\n`, { mode: 0o600 });

    const result = await run(process.execPath, [
      new URL('../scripts/node-spawn-response-loss-e2e.mjs', import.meta.url).pathname,
      '--config', config,
    ], resolveRoot());
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, run_id: 'run_fixture' });
    const evidence = JSON.parse(readFileSync(join(evidenceDir, 'response-loss-proof.json'), 'utf8'));
    expect(evidence).toMatchObject({
      schema: 'relayflows-node-spawn-response-loss-local/1',
      dropped_response_forwarded_bytes: 0,
      spawn_invoke_calls: 2,
      replay_attempts: 1,
      unique_spawn_keys: 1,
      release_calls: 1,
      inbox_settlement_calls: 1,
      final_claim: {
        version: 3,
        result_present: true,
        release_status: 'completed',
        cleanup_pending: false,
        settlement_action: 'ack',
      },
      journal: { terminal_sequence: 10, terminal_before_settlement: true },
      process_generations: {
        initial_pid: expect.any(Number),
        replay_pids: [expect.any(Number), expect.any(Number)],
      },
      deferred_assertions: [
        'stored_relaycast_contract_and_capability',
        'provider_frame_and_worker_counts',
        'target_capacity',
        'unrelated_reservation_preservation',
        'remote_fleet_lifecycle',
      ],
    });
    expect(new Set(evidence.process_generations.replay_pids).size).toBe(2);
    expect(evidence.process_generations.replay_pids).not.toContain(
      evidence.process_generations.initial_pid,
    );
    expect(upstream.upstreamSpawnFrames()).toBe(1);
  }, 20_000);
});

function resolveRoot() {
  return new URL('../../..', import.meta.url).pathname;
}
