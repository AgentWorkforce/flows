import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAgentRelayTask, type AgentRelayTaskRequest } from '../src/agent-relay-transport.js';
import { hasReplayableFencedDispatch } from '../src/node-spawn-dispatch.js';
import { createLocalNodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import { nodeSpawnDispatchFencePath, readNodeSpawnClaims } from '../src/node-spawn-state.js';

const coreBridge = vi.hoisted(() => {
  const state = {
    directoryScope: ['/tmp'] as string[],
    invokeCalls: [] as Array<{ key: string; task: string; directory: string }>,
    commits: new Set<string>(),
    dropFirstReply: true,
    releases: 0,
    subscriptions: 0,
    targetCalls: 0,
    spawnedName: '',
  };
  const core = {
    hello: { bridge_version: 1, daemon_version: 'test', pid: 1, methods: [], topics: [] },
    close: vi.fn(),
  };
  const invocation = () => ({
    id: 'inv_spawn_replayed',
    agent_id: 'agent_replayed',
    status: 'completed',
    node_id: 'node_local',
    name: state.spawnedName,
    spawned: true,
    ready: true,
    released: false,
    task_unconfirmed: false,
    error_code: null,
  });
  const bridge = {
    connectCore: vi.fn(async () => core),
    readCallerDescriptor: vi.fn(async () => ({
      schema: 'agent-relay-service-caller/2',
      schemaVersion: 2,
      auth: {},
      callerId: 'caller_local',
      callerName: 'flows-caller',
      publisher: { id: 'publisher_local', name: 'flows-publisher' },
      workspace: {
        site_url: 'https://agentrelay.com',
        base_url: 'https://cast.agentrelay.com',
        workspace_id: 'workspace_local',
        relaycast_workspace_id: 'relaycast_local',
      },
      account: { user_id: 'user_local' },
      credential: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      harnesses: ['codex'],
      directoryScope: [...state.directoryScope],
      ownsOnly: true,
      socket: '/tmp/core.sock',
      inbox: {
        transport: 'core', open: 'open', next: 'next', ack: 'ack', fail: 'fail',
        close: 'close', disconnect: 'disconnect',
      },
      desktopVersion: 'test',
    })),
    authenticate: vi.fn(async () => ({})),
    requireServiceCallerMethods: vi.fn(),
    assertServiceCallerIdentity: vi.fn(),
    serviceCallerIdentity: vi.fn(async () => ({
      publisher: { id: 'publisher_local', name: 'flows-publisher' },
      node: { id: 'node_local', name: 'desktop-local' },
      base_url: 'https://cast.agentrelay.com',
      workspace_id: 'workspace_local',
      relaycast_workspace_id: 'relaycast_local',
    })),
    spawnTargets: vi.fn(async () => {
      state.targetCalls += 1;
      return { targets: [{
        id: 'node_local', name: 'desktop-local', live: true, handlers_live: true,
        stale: false, capabilities: ['spawn:codex'], active_agents: 0,
        reserved_agents: 0, max_agents: 4,
      }] };
    }),
    spawnInvoke: vi.fn(async (_core: unknown, input: {
      name: string; task: string; directory: string; idempotency_key: string;
    }) => {
      state.spawnedName = input.name;
      state.invokeCalls.push({
        key: input.idempotency_key,
        task: input.task,
        directory: input.directory,
      });
      state.commits.add(input.idempotency_key);
      if (state.dropFirstReply) {
        state.dropFirstReply = false;
        throw new Error('bridge reply lost after strict server commit');
      }
      return invocation();
    }),
    spawnStatus: vi.fn(async () => invocation()),
    spawnRelease: vi.fn(async () => {
      state.releases += 1;
      return { ...invocation(), spawned: false, ready: false, released: true };
    }),
    serviceCallerInboxOpen: vi.fn(async () => {
      state.subscriptions += 1;
      return { iterator_id: 'iterator_replayed' };
    }),
    serviceCallerInboxNext: vi.fn(async () => ({ delivery: {
      item_id: 'delivery_replayed',
      message_id: 'message_replayed',
      sender: { id: 'agent_replayed', name: state.spawnedName },
      text: 'RELAYFLOWS_RESULT_V1 ' + JSON.stringify({
        version: 1,
        run_id: 'run_local_replay',
        step_id: 'edit',
        dispatch_id: 'local_replay_key_123',
        status: 'completed',
        output: { ok: true },
      }),
      invocation_id: 'inv_spawn_replayed',
      sent_at: '2026-01-01T00:00:00.000Z',
    } })),
    serviceCallerInboxAck: vi.fn(async () => ({})),
    serviceCallerInboxFail: vi.fn(async () => ({})),
    serviceCallerInboxClose: vi.fn(async () => ({})),
    serviceCallerDisconnect: vi.fn(async () => ({})),
  };
  return { bridge, state };
});

vi.mock('@agent-relay/core-bridge', () => coreBridge.bridge);

const roots: string[] = [];

beforeEach(() => {
  coreBridge.state.directoryScope = ['/tmp'];
  coreBridge.state.invokeCalls.length = 0;
  coreBridge.state.commits.clear();
  coreBridge.state.dropFirstReply = true;
  coreBridge.state.releases = 0;
  coreBridge.state.subscriptions = 0;
  coreBridge.state.targetCalls = 0;
  coreBridge.state.spawnedName = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flows-local-replay-gap-'));
  roots.push(directory);
  return directory;
}

function request(dataDir: string, workerCwd = '/tmp'): AgentRelayTaskRequest {
  return {
    cli: 'codex',
    task: 'Implement the exact change',
    taskIdentity: 'task_sha256_exact',
    runId: 'run_local_replay',
    stepId: 'edit',
    idempotencyKey: 'local_replay_key_123',
    attempt: 1,
    dataDir,
    timeoutMs: 10_000,
    worker_cwd: workerCwd,
  };
}

describe('official local strict replay', () => {
  it('replays an accepted same-key claim after current directory scope is revoked', async () => {
    const dataDir = await dataDirectory();
    const crashedRuntime = await createLocalNodeSpawnRuntime('/tmp/caller.json');

    await expect(runAgentRelayTask(request(dataDir), { runtime: crashedRuntime }))
      .rejects.toThrow('bridge reply lost after strict server commit');
    coreBridge.state.directoryScope = ['/revoked-root'];
    const restartedRuntime = await createLocalNodeSpawnRuntime('/tmp/caller.json');
    const recovered = await Promise.all([
      runAgentRelayTask(request(dataDir), { runtime: restartedRuntime }),
      runAgentRelayTask(request(dataDir), { runtime: restartedRuntime }),
    ]);
    expect(recovered).toEqual([
      expect.objectContaining({ receipt: expect.objectContaining({ status: 'completed' }) }),
      expect.objectContaining({ receipt: expect.objectContaining({ status: 'completed' }) }),
    ]);

    expect(coreBridge.state.invokeCalls).toHaveLength(2);
    expect(coreBridge.state.invokeCalls[0]).toEqual(coreBridge.state.invokeCalls[1]);
    expect(coreBridge.state.invokeCalls[0]).toMatchObject({
      key: 'local_replay_key_123',
      directory: '/tmp',
    });
    expect(coreBridge.state.invokeCalls[0]!.task).toContain('Implement the exact change');
    expect([...coreBridge.state.commits]).toEqual(['local_replay_key_123']);
    expect(coreBridge.state.targetCalls).toBe(1);
    expect(coreBridge.state.subscriptions).toBe(1);
    expect(coreBridge.state.releases).toBe(1);
  });

  it('still applies current directory scope before a new unfenced dispatch', async () => {
    const dataDir = await dataDirectory();
    coreBridge.state.directoryScope = ['/revoked-root'];
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json');

    await expect(runAgentRelayTask(request(dataDir), { runtime }))
      .rejects.toThrow('does not authorize this harness and directory');
    expect(coreBridge.state.invokeCalls).toHaveLength(0);
    expect(coreBridge.state.targetCalls).toBe(0);
    const [claim] = await readNodeSpawnClaims(dataDir);
    await expect(readFile(nodeSpawnDispatchFencePath(claim!.path), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['spawn', 'targets', 'status', 'release'] as const)(
    'revokes replay trust when authentic port method %s is overridden', async method => {
      const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json');
      expect(hasReplayableFencedDispatch(runtime.port)).toBe(true);
      const original = runtime.port[method].bind(runtime.port);
      Object.defineProperty(runtime.port, method, { value: vi.fn(original) });
      expect(hasReplayableFencedDispatch(runtime.port)).toBe(false);
    },
  );

  it.each(['core', 'bridge', 'scope', 'exactNode'] as const)(
    'revokes replay trust when authentic port state %s is replaced', async field => {
      const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json');
      expect(hasReplayableFencedDispatch(runtime.port)).toBe(true);
      Object.defineProperty(runtime.port, field, { value: {}, configurable: true });
      expect(hasReplayableFencedDispatch(runtime.port)).toBe(false);
    },
  );
});
