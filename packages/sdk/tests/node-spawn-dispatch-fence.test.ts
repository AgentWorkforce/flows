import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentRelayTask, type AgentRelayTaskRequest } from '../src/agent-relay-transport.js';
import { LocalNodeSpawnPort, type CoreBridgeClient } from '../src/node-spawn-local.js';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import { claimNodeSpawnDispatch, nodeSpawnDispatchFencePath, readNodeSpawnClaims,
  recordNodeSpawn } from '../src/node-spawn-state.js';
import { NodeSpawnError, NodeSpawnPreDispatchError,
  type NodeSpawnPort, type NodeSpawnReceipt } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function dataDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  roots.push(directory);
  return directory;
}

function request(dataDir: string, timeoutMs = 10_000): AgentRelayTaskRequest {
  return {
    cli: 'codex', task: 'Implement the change', runId: 'run_fence', stepId: 'edit',
    idempotencyKey: 'dispatch_fence123', attempt: 1, dataDir, timeoutMs,
    worker_cwd: '/tmp',
  };
}

function officialLocalRuntime(options: {
  eligible(): boolean;
  invoked(name: string): void;
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
  const invocation = (name: string) => ({
    id: 'inv_spawn_1',
    agent_id: 'agent_1',
    status: 'completed',
    node_id: 'node_1',
    name,
    spawned: true,
    ready: true,
    released: false,
    task_unconfirmed: false,
    error_code: null,
  });
  let spawnedName = '';
  const bridge: ConstructorParameters<typeof LocalNodeSpawnPort>[1] = {
    spawnTargets: vi.fn(async () => ({
      targets: options.eligible() ? [{
        id: 'node_1',
        name: 'desktop-1',
        live: true,
        handlers_live: true,
        stale: false,
        capabilities: ['spawn:codex'],
        active_agents: 0,
        reserved_agents: 0,
        max_agents: 4,
      }] : [],
    })),
    spawnInvoke: vi.fn(async (_core, input) => {
      spawnedName = input.name;
      options.invoked(input.name);
      return invocation(input.name);
    }),
    spawnStatus: vi.fn(async () => invocation(spawnedName)),
    spawnRelease: vi.fn(async () => ({
      ...invocation(spawnedName),
      spawned: false,
      ready: false,
      released: true,
    })),
  };
  return {
    authority: 'desktop',
    publisher: { id: 'publisher_1', name: 'flows-publisher' },
    baseUrl: 'https://cast.agentrelay.com',
    port: new LocalNodeSpawnPort(core, bridge, {
      harnesses: ['codex'],
      directoryScope: ['/tmp'],
    }, { id: 'node_1', name: 'desktop-1' }),
    inbox: { inbox: {
      subscribe: async function* () {
        yield { id: 'delivery_1', message: { id: 'message_1',
          from: { id: 'agent_1', name: spawnedName },
          text: NODE_RESULT_PREFIX + JSON.stringify({
            version: 1, run_id: 'run_fence', step_id: 'edit',
            dispatch_id: 'dispatch_fence123', status: 'completed', output: { ok: true },
          }) } };
      },
      ack: vi.fn(async () => ({})),
      fail: vi.fn(async () => ({})),
    } },
  };
}

function readyReceipt(name: string): NodeSpawnReceipt {
  return {
    id: 'inv_spawn_1', action: 'spawn', status: 'completed', nodeId: 'node_1',
    nodeName: 'desktop-1', name, agentId: 'agent_1', spawned: true, ready: true,
  };
}

function runtime(spawn: NodeSpawnPort['spawn']): NodeSpawnRuntime {
  let spawnedName = '';
  const wrapped = vi.fn<NodeSpawnPort['spawn']>(async (input, beforeDispatch) => {
    const receipt = await spawn(input, beforeDispatch);
    spawnedName = receipt.name;
    return receipt;
  });
  return {
    authority: 'desktop',
    publisher: { id: 'publisher_1', name: 'flows-publisher' },
    baseUrl: 'https://cast.agentrelay.com',
    port: {
      dispatchFenceVersion: 1,
      targets: async () => [],
      spawn: wrapped,
      status: vi.fn(),
      release: vi.fn(async () => ({
        id: 'inv_release_1', action: 'release' as const, status: 'completed' as const,
        spawned: false, ready: false, released: true,
      })),
    },
    inbox: { inbox: {
      subscribe: async function* () {
        yield { id: 'delivery_1', message: { id: 'message_1',
          from: { id: 'agent_1', name: spawnedName },
          text: NODE_RESULT_PREFIX + JSON.stringify({
            version: 1, run_id: 'run_fence', step_id: 'edit',
            dispatch_id: 'dispatch_fence123', status: 'completed', output: { ok: true },
          }) } };
      },
      ack: vi.fn(async () => ({})),
      fail: vi.fn(async () => ({})),
    } },
  };
}

const preDispatchFailure = (message: string, code = 'no_eligible_node'): NodeSpawnPreDispatchError =>
  new NodeSpawnPreDispatchError(new NodeSpawnError(message, code));

describe('durable node-spawn dispatch fence', () => {
  it('lets an official port retry proven preflight once when eligible', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-retry-');
    let eligible = false;
    let invokes = 0;
    const worker = officialLocalRuntime({
      eligible: () => eligible,
      invoked() { invokes += 1; },
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('No eligible local Agent Relay spawn target');
    const [claim] = await readNodeSpawnClaims(dataDir);
    expect(claim!.claim.version).toBe(3);
    await expect(readFile(nodeSpawnDispatchFencePath(claim!.path), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    eligible = true;
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .resolves.toMatchObject({ receipt: { status: 'completed' } });
    expect(invokes).toBe(1);
  });

  it('fences an arbitrary public port before entering any of its code', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-public-port-');
    let calls = 0;
    let fenceAtEntry = false;
    const worker = runtime(async () => {
      calls += 1;
      const [entry] = await readNodeSpawnClaims(dataDir);
      await readFile(nodeSpawnDispatchFencePath(entry!.path), 'utf8');
      fenceAtEntry = true;
      throw preDispatchFailure('custom preflight cannot be trusted');
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('custom preflight cannot be trusted');
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('ambiguous pre-ack');
    expect(fenceAtEntry).toBe(true);
    expect(calls).toBe(1);
  });

  it('rejects an old public custom port before it creates a claim or invokes', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-old-port-');
    const spawn = vi.fn(async (input: Parameters<NodeSpawnPort['spawn']>[0]) => readyReceipt(input.name));
    const legacyPort = {
      targets: async () => [],
      spawn,
      status: vi.fn(),
      release: vi.fn(),
    };
    // The public contract makes the migration compile-time visible too.
    // @ts-expect-error dispatchFenceVersion is required for the fenced protocol.
    const incompatible: NodeSpawnPort = legacyPort;
    const worker = runtime(async () => readyReceipt('unused'));
    for (const incompatiblePort of [
      incompatible,
      { ...legacyPort, dispatchFenceVersion: 2 } as unknown as NodeSpawnPort,
    ]) {
      worker.port = incompatiblePort;
      await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
        .rejects.toThrow('does not implement durable dispatch-fence protocol version 1');
    }
    expect(spawn).not.toHaveBeenCalled();
    await expect(readNodeSpawnClaims(dataDir)).resolves.toEqual([]);
  });

  it('permanently refuses retry after the port crossed the fence and then failed', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-post-');
    let invokes = 0;
    const worker = runtime(async (_input, beforeDispatch) => {
      await beforeDispatch();
      invokes += 1;
      throw new Error('connection dropped after invoke');
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('connection dropped after invoke');
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('ambiguous pre-ack');
    expect(invokes).toBe(1);
  });

  it('lets exactly one independent fence contender enter its irreversible call', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-race-');
    const worker = officialLocalRuntime({ eligible: () => false, invoked() {} });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('No eligible local Agent Relay spawn target');
    const [entry] = await readNodeSpawnClaims(dataDir);
    let invokes = 0;
    const contender = async (): Promise<void> => {
      await claimNodeSpawnDispatch(entry!.path, entry!.claim);
      invokes += 1;
    };

    const results = await Promise.allSettled([contender(), contender()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(invokes).toBe(1);
  });

  it('keeps a receipt-less legacy v2 claim ambiguous', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-legacy-');
    let calls = 0;
    const worker = runtime(async () => {
      calls += 1;
      throw preDispatchFailure('prepare legacy claim');
    });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('prepare legacy claim');
    const [entry] = await readNodeSpawnClaims(dataDir);
    await recordNodeSpawn(entry!.path, { ...entry!.claim, version: 2 });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('ambiguous pre-ack');
    expect(calls).toBe(1);
  });

  it('rejects a string claim protocol version instead of coercing it', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-string-version-');
    let calls = 0;
    const worker = runtime(async () => {
      calls += 1;
      throw preDispatchFailure('prepare malformed claim');
    });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('prepare malformed claim');
    const [entry] = await readNodeSpawnClaims(dataDir);
    await writeFile(entry!.path, JSON.stringify({ ...entry!.claim, version: '3' }));

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('Invalid durable node-spawn claim');
    expect(calls).toBe(1);
  });

  it.each([
    { label: 'malformed JSON', content: '{' },
    { label: 'wrong claim digest', content: JSON.stringify({ version: 1, claimDigest: '0'.repeat(64) }) },
  ])('fails closed on a $label dispatch fence', async ({ content }) => {
    const dataDir = await dataDirectory('flows-dispatch-fence-invalid-');
    let calls = 0;
    const worker = runtime(async () => {
      calls += 1;
      throw preDispatchFailure('prepare invalid fence');
    });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('prepare invalid fence');
    const [entry] = await readNodeSpawnClaims(dataDir);
    await writeFile(nodeSpawnDispatchFencePath(entry!.path), content);

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('Invalid durable node-spawn dispatch fence');
    expect(calls).toBe(1);
  });

  it('treats a non-ENOENT fence read failure as invalid durable state', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-read-failure-');
    let invokes = 0;
    const worker = officialLocalRuntime({
      eligible: () => false,
      invoked() { invokes += 1; },
    });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('No eligible local Agent Relay spawn target');
    const [entry] = await readNodeSpawnClaims(dataDir);
    await mkdir(nodeSpawnDispatchFencePath(entry!.path));

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('Invalid durable node-spawn dispatch fence');
    expect(invokes).toBe(0);
  });

  it('does not call the remote effect when dispatch-fence publication fails', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-write-failure-');
    let eligible = false;
    let remoteCalls = 0;
    const worker = officialLocalRuntime({
      eligible: () => eligible,
      invoked() { remoteCalls += 1; },
    });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('No eligible local Agent Relay spawn target');
    const [entry] = await readNodeSpawnClaims(dataDir);
    eligible = true;
    await chmod(dirname(entry!.path), 0o500);
    try {
      await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
        .rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(dirname(entry!.path), 0o700);
    }
    expect(remoteCalls).toBe(0);
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .resolves.toMatchObject({ receipt: { status: 'completed' } });
    expect(remoteCalls).toBe(1);
  });

  it('retains the original claim deadline across a safe pre-dispatch retry', async () => {
    vi.useFakeTimers();
    const dataDir = await dataDirectory('flows-dispatch-fence-deadline-');
    let invokes = 0;
    const worker = officialLocalRuntime({
      eligible: () => false,
      invoked() { invokes += 1; },
    });
    await expect(runAgentRelayTask(request(dataDir, 1_000), { runtime: worker }))
      .rejects.toThrow('No eligible local Agent Relay spawn target');
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(runAgentRelayTask(request(dataDir, 1_000), { runtime: worker }))
      .rejects.toThrow('deadline elapsed');
    expect(invokes).toBe(0);
  });

  it('treats an overridden built-in spawn method as an arbitrary port', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-overridden-port-');
    const worker = officialLocalRuntime({ eligible: () => true, invoked() {} });
    let fenceAtEntry = false;
    const originalSpawn = worker.port.spawn.bind(worker.port);
    worker.port.spawn = vi.fn(async (input, beforeDispatch) => {
      const [entry] = await readNodeSpawnClaims(dataDir);
      await readFile(nodeSpawnDispatchFencePath(entry!.path), 'utf8');
      fenceAtEntry = true;
      return originalSpawn(input, beforeDispatch);
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .resolves.toMatchObject({ receipt: { status: 'completed' } });
    expect(fenceAtEntry).toBe(true);
  });

  it('treats an overridden built-in target preflight as arbitrary code', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-overridden-targets-');
    const worker = officialLocalRuntime({ eligible: () => true, invoked() {} });
    let fenceAtEntry = false;
    const originalTargets = worker.port.targets.bind(worker.port);
    worker.port.targets = vi.fn(async () => {
      const [entry] = await readNodeSpawnClaims(dataDir);
      await readFile(nodeSpawnDispatchFencePath(entry!.path), 'utf8');
      fenceAtEntry = true;
      return originalTargets();
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .resolves.toMatchObject({ receipt: { status: 'completed' } });
    expect(fenceAtEntry).toBe(true);
  });

  it('does not trust a local spawn prototype replaced before construction', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-replaced-prototype-');
    const originalSpawn = LocalNodeSpawnPort.prototype.spawn;
    let fenceAtEntry = false;
    LocalNodeSpawnPort.prototype.spawn = async function (input, beforeDispatch) {
      const [entry] = await readNodeSpawnClaims(dataDir);
      await readFile(nodeSpawnDispatchFencePath(entry!.path), 'utf8');
      fenceAtEntry = true;
      return originalSpawn.call(this, input, beforeDispatch);
    };
    try {
      const worker = officialLocalRuntime({ eligible: () => true, invoked() {} });
      await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
        .resolves.toMatchObject({ receipt: { status: 'completed' } });
      expect(fenceAtEntry).toBe(true);
    } finally {
      LocalNodeSpawnPort.prototype.spawn = originalSpawn;
    }
  });

  it('keeps an arbitrary port fenced when it returns without calling the hook', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-bypass-');
    let calls = 0;
    let fenceAtEntry = false;
    const worker = runtime(async input => {
      calls += 1;
      const [entry] = await readNodeSpawnClaims(dataDir);
      await readFile(nodeSpawnDispatchFencePath(entry!.path), 'utf8');
      fenceAtEntry = true;
      return readyReceipt(input.name);
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .resolves.toMatchObject({ receipt: { status: 'completed' } });
    expect(fenceAtEntry).toBe(true);
    expect(calls).toBe(1);
  });
});
