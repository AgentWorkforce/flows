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
  droppedSpawnReply?: { invocationId?: string; responseDigest: string; responseBytes: number };
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
  verifyResponseLossEvidence(stats: ProxyStats, audit: unknown): unknown;
}

const moduleUrl = new URL('../scripts/node-spawn-response-loss-proxy.mjs', import.meta.url).href;
const runnerModuleUrl = new URL('../scripts/node-spawn-response-loss-e2e.mjs', import.meta.url).href;
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
            result: { id: 'invocation-1', status: 'completed' },
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
      params: { idempotency_key: 'a'.repeat(32), task: 'exact original task bytes' },
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
    expect(() => module.verifyResponseLossEvidence(proxy.stats, {
      schema: 'relayflows-node-spawn-response-loss/1',
      strict_contract: 'relay.spawn.invoke.logical-replay-resume/1',
      strict_replay_capability: 'relay.spawn.replay-resume/1',
      strict_invocation_committed: true,
      upstream_spawn_frames: 1,
      workers_created: 1,
      correlated_results: 1,
      releases: 1,
      final_claim: { result_present: true, release_confirmed: true, cleanup_pending: false },
      target_capacity: { active_agents: 0, reserved_agents: 0 },
      journal_terminal_sequence: 10,
      inbox_settlement_sequence: 11,
      unrelated_reservation: {
        before: { identity: 'unrelated-1', count: 1 },
        after: { identity: 'unrelated-1', count: 1 },
      },
    })).not.toThrow();
  });

  it('rejects changed task bytes even when the fixture reports a clean lifecycle', async () => {
    const module = await import(moduleUrl) as ProxyModule;
    const stats: ProxyStats = {
      methodCounts: { 'spawn.invoke': 3, 'spawn.release': 1, 'spawn_callers.inbox.ack': 1 },
      spawnInvokeTaskDigests: ['one', 'two', 'two'],
      spawnInvokeKeys: ['key', 'key', 'key'],
      droppedSpawnReply: { responseDigest: 'reply', responseBytes: 12 },
      droppedSpawnReplyForwardedBytes: 0,
    };
    expect(() => module.verifyResponseLossEvidence(stats, {
      schema: 'relayflows-node-spawn-response-loss/1',
      strict_contract: 'relay.spawn.invoke.logical-replay-resume/1',
      strict_replay_capability: 'relay.spawn.replay-resume/1',
      strict_invocation_committed: true,
      upstream_spawn_frames: 1,
      workers_created: 1,
      correlated_results: 1,
      releases: 1,
      final_claim: { result_present: true, release_confirmed: true, cleanup_pending: false },
      target_capacity: { active_agents: 0, reserved_agents: 0 },
      journal_terminal_sequence: 10,
      inbox_settlement_sequence: 11,
      unrelated_reservation: {
        before: { identity: 'unrelated-1', count: 1 },
        after: { identity: 'unrelated-1', count: 1 },
      },
    })).toThrow('original task bytes');
  });

  it('requires stored strict proofs and an unchanged unrelated reservation', async () => {
    const module = await import(moduleUrl) as ProxyModule;
    const stats: ProxyStats = {
      methodCounts: { 'spawn.invoke': 3, 'spawn.release': 1, 'spawn_callers.inbox.ack': 1 },
      spawnInvokeTaskDigests: ['same', 'same', 'same'],
      spawnInvokeKeys: ['key', 'key', 'key'],
      droppedSpawnReply: { responseDigest: 'reply', responseBytes: 12 },
      droppedSpawnReplyForwardedBytes: 0,
    };
    const audit = {
      schema: 'relayflows-node-spawn-response-loss/1',
      strict_contract: 'relay.spawn.invoke.logical-replay-resume/1',
      strict_replay_capability: 'relay.spawn.replay-resume/1',
      strict_invocation_committed: true,
      upstream_spawn_frames: 1,
      workers_created: 1,
      correlated_results: 1,
      releases: 1,
      final_claim: { result_present: true, release_confirmed: true, cleanup_pending: false },
      target_capacity: { active_agents: 0, reserved_agents: 0 },
      journal_terminal_sequence: 10,
      inbox_settlement_sequence: 11,
      unrelated_reservation: {
        before: { identity: 'unrelated-1', count: 1 },
        after: { identity: 'unrelated-1', count: 1 },
      },
    };
    expect(() => module.verifyResponseLossEvidence(stats, {
      ...audit,
      strict_replay_capability: 'legacy',
    })).toThrow();
    expect(() => module.verifyResponseLossEvidence(stats, {
      ...audit,
      unrelated_reservation: {
        ...audit.unrelated_reservation,
        after: { identity: 'unrelated-1', count: 0 },
      },
    })).toThrow('unrelated reservation');
    expect(() => module.verifyResponseLossEvidence(stats, {
      ...audit,
      final_claim: { ...audit.final_claim, result_present: false },
    })).toThrow('retain its correlated result');
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
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
const [mode, dataDir, winner] = process.argv.slice(2);
const caller = JSON.parse(readFileSync(process.env.RELAYFLOW_SERVICE_CALLER_FILE, 'utf8'));
const rpc = (method, id) => new Promise((resolve, reject) => {
  const socket = net.createConnection(caller.socket);
  let buffered = '';
  socket.once('error', reject);
  socket.once('connect', () => socket.write(JSON.stringify({
    jsonrpc: '2.0', id, method, params: method === 'spawn.invoke'
      ? { idempotency_key: 'a'.repeat(32), task: 'exact original task bytes' }
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
  closeSync(openSync(join(dataDir, 'runs', 'run_fixture.sqlite3'), 'w'));
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
`);

    const auditScript = join(root, 'audit.mjs');
    writeFileSync(auditScript, `console.log(JSON.stringify({
  schema: 'relayflows-node-spawn-response-loss/1',
  strict_contract: 'relay.spawn.invoke.logical-replay-resume/1',
  strict_replay_capability: 'relay.spawn.replay-resume/1',
  strict_invocation_committed: true,
  upstream_spawn_frames: 1,
  workers_created: 1,
  correlated_results: 1,
  releases: 1,
  final_claim: { result_present: true, release_confirmed: true, cleanup_pending: false },
  target_capacity: { active_agents: 0, reserved_agents: 0 },
  journal_terminal_sequence: 10,
  inbox_settlement_sequence: 11,
  unrelated_reservation: {
    before: { identity: 'unrelated-1', count: 1 },
    after: { identity: 'unrelated-1', count: 1 },
  },
}));\n`);
    const config = join(root, 'config.json');
    writeFileSync(config, `${JSON.stringify({
      callerFile,
      dataDir,
      evidenceDir,
      homeDir,
      workDir,
      start: { command: process.execPath, args: [childScript, 'start', dataDir, join(root, 'winner')] },
      resume: { command: process.execPath, args: [childScript, 'resume', dataDir, join(root, 'winner'), '{RUN_ID}'] },
      audit: { command: process.execPath, args: [auditScript, '{RUN_ID}'] },
    })}\n`, { mode: 0o600 });

    const result = await run(process.execPath, [
      new URL('../scripts/node-spawn-response-loss-e2e.mjs', import.meta.url).pathname,
      '--config', config,
    ], resolveRoot());
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, run_id: 'run_fixture' });
    const evidence = JSON.parse(readFileSync(join(evidenceDir, 'response-loss-proof.json'), 'utf8'));
    expect(evidence).toMatchObject({
      dropped_response_forwarded_bytes: 0,
      spawn_invoke_calls: 2,
      upstream_spawn_frames: 1,
      workers_created: 1,
      correlated_results: 1,
      releases: 1,
      final_claim: { result_present: true, release_confirmed: true, cleanup_pending: false },
      target_capacity: { active_agents: 0, reserved_agents: 0 },
      unrelated_reservation: {
        before: { identity: 'unrelated-1', count: 1 },
        after: { identity: 'unrelated-1', count: 1 },
      },
      process_generations: {
        initial_pid: expect.any(Number),
        replay_pids: [expect.any(Number), expect.any(Number)],
      },
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
