import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAgentRelayTask, type AgentRelayTaskRequest } from '../src/agent-relay-transport.js';
import { LocalNodeSpawnPort, type CoreBridgeClient } from '../src/node-spawn-local.js';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flows-local-replay-gap-'));
  roots.push(directory);
  return directory;
}

function request(dataDir: string): AgentRelayTaskRequest {
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
    worker_cwd: '/tmp',
  };
}

function strictReplayRuntime(observed: {
  invokeCalls: Array<{ key: string; task: string }>;
  commits: Set<string>;
  dropFirstReply: boolean;
  releases: number;
  subscriptions: number;
}): NodeSpawnRuntime {
  const core: CoreBridgeClient = {
    hello: {
      bridge_version: 1,
      daemon_version: 'test',
      pid: process.pid,
      methods: [],
      topics: [],
    },
    close() {},
  };
  let spawnedName = '';
  const invocation = () => ({
    id: 'inv_spawn_replayed',
    agent_id: 'agent_replayed',
    status: 'completed',
    node_id: 'node_local',
    name: spawnedName,
    spawned: true,
    ready: true,
    released: false,
    task_unconfirmed: false,
    error_code: null,
  });
  const bridge: ConstructorParameters<typeof LocalNodeSpawnPort>[1] = {
    spawnTargets: vi.fn(async () => ({
      targets: [{
        id: 'node_local',
        name: 'desktop-local',
        live: true,
        handlers_live: true,
        stale: false,
        capabilities: ['spawn:codex'],
        active_agents: 0,
        reserved_agents: 0,
        max_agents: 4,
      }],
    })),
    spawnInvoke: vi.fn(async (_core, input) => {
      spawnedName = input.name;
      observed.invokeCalls.push({ key: input.idempotency_key, task: input.task });
      observed.commits.add(input.idempotency_key);
      if (observed.dropFirstReply) {
        observed.dropFirstReply = false;
        throw new Error('bridge reply lost after strict server commit');
      }
      return invocation();
    }),
    spawnStatus: vi.fn(async () => invocation()),
    spawnRelease: vi.fn(async () => {
      observed.releases += 1;
      return {
        ...invocation(),
        spawned: false,
        ready: false,
        released: true,
      };
    }),
  };
  return {
    authority: 'desktop',
    publisher: { id: 'publisher_local', name: 'flows-publisher' },
    baseUrl: 'https://cast.agentrelay.com',
    port: new LocalNodeSpawnPort(core, bridge, {
      harnesses: ['codex'],
      directoryScope: ['/tmp'],
    }, { id: 'node_local', name: 'desktop-local' }),
    inbox: { inbox: {
      subscribe: async function* () {
        observed.subscriptions += 1;
        yield {
          id: 'delivery_replayed',
          message: {
            id: 'message_replayed',
            from: { id: 'agent_replayed', name: spawnedName },
            text: NODE_RESULT_PREFIX + JSON.stringify({
              version: 1,
              run_id: 'run_local_replay',
              step_id: 'edit',
              dispatch_id: 'local_replay_key_123',
              status: 'completed',
              output: { ok: true },
            }),
          },
        };
      },
      ack: vi.fn(async () => ({})),
      fail: vi.fn(async () => ({})),
    } },
  };
}

describe('official local strict replay', () => {
  it('replays the same idempotency key after the first committed reply is lost', async () => {
    const dataDir = await dataDirectory();
    const observed = {
      invokeCalls: [] as Array<{ key: string; task: string }>,
      commits: new Set<string>(),
      dropFirstReply: true,
      releases: 0,
      subscriptions: 0,
    };
    const crashedRuntime = strictReplayRuntime(observed);

    await expect(runAgentRelayTask(request(dataDir), { runtime: crashedRuntime }))
      .rejects.toThrow('bridge reply lost after strict server commit');
    const restartedRuntime = strictReplayRuntime(observed);
    const recovered = await Promise.all([
      runAgentRelayTask(request(dataDir), { runtime: restartedRuntime }),
      runAgentRelayTask(request(dataDir), { runtime: restartedRuntime }),
    ]);
    expect(recovered).toEqual([
      expect.objectContaining({ receipt: expect.objectContaining({ status: 'completed' }) }),
      expect.objectContaining({ receipt: expect.objectContaining({ status: 'completed' }) }),
    ]);

    expect(observed.invokeCalls).toHaveLength(2);
    expect(observed.invokeCalls[0]).toEqual(observed.invokeCalls[1]);
    expect(observed.invokeCalls[0]).toMatchObject({ key: 'local_replay_key_123' });
    expect(observed.invokeCalls[0]!.task).toContain('Implement the exact change');
    expect([...observed.commits]).toEqual(['local_replay_key_123']);
    expect(observed.subscriptions).toBe(1);
    expect(observed.releases).toBe(1);
  });
});
