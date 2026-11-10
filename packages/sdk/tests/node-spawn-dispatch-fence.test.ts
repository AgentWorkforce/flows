import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentRelayTask, type AgentRelayTaskRequest } from '../src/agent-relay-transport.js';
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
  it('lets a public custom port attest safe preflight and retry once when eligible', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-retry-');
    let eligible = false;
    let invokes = 0;
    const worker = runtime(async (input, beforeDispatch) => {
      if (!eligible) throw preDispatchFailure('no eligible node');
      await beforeDispatch();
      invokes += 1;
      return readyReceipt(input.name);
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('no eligible node');
    const [claim] = await readNodeSpawnClaims(dataDir);
    expect(claim!.claim.version).toBe(3);
    await expect(readFile(nodeSpawnDispatchFencePath(claim!.path), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    eligible = true;
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .resolves.toMatchObject({ receipt: { status: 'completed' } });
    expect(invokes).toBe(1);
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
    const worker = runtime(async () => { throw preDispatchFailure('prepare claim'); });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker })).rejects.toThrow('prepare claim');
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
    let calls = 0;
    const worker = runtime(async () => {
      calls += 1;
      throw preDispatchFailure('prepare unreadable fence');
    });
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('prepare unreadable fence');
    const [entry] = await readNodeSpawnClaims(dataDir);
    await mkdir(nodeSpawnDispatchFencePath(entry!.path));

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('Invalid durable node-spawn dispatch fence');
    expect(calls).toBe(1);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not call the remote effect when dispatch-fence publication fails',
    async () => {
      const dataDir = await dataDirectory('flows-dispatch-fence-write-failure-');
      let prepare = true;
      let remoteCalls = 0;
      const worker = runtime(async (input, beforeDispatch) => {
        if (prepare) throw preDispatchFailure('prepare fence failure');
        await beforeDispatch();
        remoteCalls += 1;
        return readyReceipt(input.name);
      });
      await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
        .rejects.toThrow('prepare fence failure');
      const [entry] = await readNodeSpawnClaims(dataDir);
      prepare = false;
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
    },
  );

  it('retains the original claim deadline across a safe pre-dispatch retry', async () => {
    vi.useFakeTimers();
    const dataDir = await dataDirectory('flows-dispatch-fence-deadline-');
    let calls = 0;
    const worker = runtime(async () => {
      calls += 1;
      throw preDispatchFailure('not ready yet');
    });
    await expect(runAgentRelayTask(request(dataDir, 1_000), { runtime: worker }))
      .rejects.toThrow('not ready yet');
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(runAgentRelayTask(request(dataDir, 1_000), { runtime: worker }))
      .rejects.toThrow('deadline elapsed');
    expect(calls).toBe(1);
  });

  it('fences a custom port that returns a receipt without awaiting the required hook', async () => {
    const dataDir = await dataDirectory('flows-dispatch-fence-bypass-');
    let calls = 0;
    const worker = runtime(async input => {
      calls += 1;
      return readyReceipt(input.name);
    });

    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('required dispatch fence');
    await expect(runAgentRelayTask(request(dataDir), { runtime: worker }))
      .rejects.toThrow('required dispatch fence');
    expect(calls).toBe(1);
  });
});
