import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { JournalClient } from '../src/journal-client.js';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import type { NodeSpawnIdentity, NodeSpawnReceipt } from '../src/node-spawn.js';
import { AgentWorker } from '../src/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOLCHAIN_TARGET =
  process.env['CARGO_TARGET_DIR'] ??
  join(
    process.env['RELAYFLOWS_TOOLCHAIN_HOME'] ??
      join(homedir(), '.relayflows-toolchain'),
    'target',
  );
const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN'] ?? locateRelayflowd());
const roots: string[] = [];
const daemons: ChildProcess[] = [];
const clients: JournalClient[] = [];

beforeAll(() => accessSync(RELAYFLOWD, constants.X_OK));

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('node-spawn transport through the real journal', () => {
  it('runs a relay agent step, releases exact identity, journals, then acknowledges', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'flows-node-spawn-live-'));
    roots.push(dataDir);
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('node-spawn-live-test');

    let runId = '';
    let allowSpawn!: () => void;
    const runReady = new Promise<void>((resolveReady) => {
      allowSpawn = resolveReady;
    });
    let resolveSpawn!: (receipt: NodeSpawnReceipt) => void;
    const spawned = new Promise<NodeSpawnReceipt>((resolveReceipt) => {
      resolveSpawn = resolveReceipt;
    });
    let dispatchId = '';
    const releases: Array<{
      receipt: NodeSpawnIdentity;
      idempotencyKey: string;
    }> = [];
    const ackStates: string[] = [];
    const runtime: NodeSpawnRuntime = {
      baseUrl: 'https://cast.agentrelay.com',
      publisher: { id: 'publisher_1', name: 'flows-publisher' },
      port: {
        targets: async () => [],
        spawn: async (input) => {
          await runReady;
          dispatchId = input.idempotencyKey;
          const receipt: NodeSpawnReceipt = {
            id: 'spawn_1',
            action: 'spawn',
            status: 'completed',
            nodeId: 'node_1',
            nodeName: 'desktop-1',
            name: input.name,
            agentId: 'agent_1',
            spawned: true,
            ready: true,
          };
          resolveSpawn(receipt);
          return receipt;
        },
        status: async () => {
          throw new Error('first-attempt run must not poll a prior spawn');
        },
        release: async (input) => {
          releases.push({
            receipt: input.receipt,
            idempotencyKey: input.idempotencyKey,
          });
          return {
            id: 'release_1',
            action: 'release',
            status: 'completed',
            spawned: false,
            ready: false,
            released: true,
          };
        },
      },
      inbox: {
        inbox: {
          subscribe: async function* () {
            const receipt = await spawned;
            yield {
              id: 'delivery_1',
              message: {
                id: 'message_1',
                from: { id: receipt.agentId, name: receipt.name },
                text:
                  NODE_RESULT_PREFIX +
                  JSON.stringify({
                    version: 1,
                    run_id: runId,
                    step_id: 'edit',
                    dispatch_id: dispatchId,
                    status: 'completed',
                    output: { summary: 'node-spawn journal round trip' },
                    accounting: { tokens_input: 3, tokens_output: 5 },
                  }),
              },
            };
          },
          ack: async () => {
            const snapshot = await client.runGet(runId);
            ackStates.push(snapshot.steps['edit']?.state ?? 'missing');
            return {};
          },
          fail: async () => {
            throw new Error('valid result must not fail its delivery');
          },
        },
      },
    };
    const worker = new AgentWorker(client, {
      workerId: 'node-spawn-live-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
      dataDir,
      nodeSpawnRuntime: runtime,
    });
    const workerErrors: unknown[] = [];
    worker.on('error', (error) => workerErrors.push(error));
    await worker.attach();

    try {
      const started = await client.runStart(
        toKernelSpec(
          compileYaml(`
version: '0.1.0'
steps:
  - id: edit
    type: agent
    cli: codex
    model: codex-medium
    transport: relay
    instruction: Perform the declared work.
`),
        ),
      );
      runId = started.run_id;
      allowSpawn();
      const step = await waitForStep(client, runId, 'edit', 'done');
      const completed = (await client.journalRead(runId, 1, 100)).entries.find(
        (entry) =>
          (entry as { entry_type?: string; step_id?: string }).entry_type ===
            'step.completed' &&
          (entry as { step_id?: string }).step_id === 'edit',
      );

      expect(workerErrors).toEqual([]);
      expect(step).toMatchObject({ state: 'done', type: 'agent' });
      expect(completed).toMatchObject({
        payload: {
          completionReason: 'success',
          output: { summary: 'node-spawn journal round trip' },
        },
      });
      expect(releases).toEqual([
        {
          receipt: expect.objectContaining({
            id: 'spawn_1',
            nodeId: 'node_1',
            nodeName: 'desktop-1',
            agentId: 'agent_1',
          }),
          idempotencyKey: expect.stringMatching(/^release_[a-f0-9]{32}$/),
        },
      ]);
      expect(ackStates).toEqual(['done']);
    } finally {
      allowSpawn();
      await worker.close();
    }
  }, 20_000);
});

function locateRelayflowd(): string {
  const direct = join(TOOLCHAIN_TARGET, 'debug', 'relayflowd');
  if (existsSync(direct)) return direct;
  if (!existsSync(TOOLCHAIN_TARGET))
    return join(ROOT, 'kernel', 'target', 'debug', 'relayflowd');
  return (
    readdirSync(TOOLCHAIN_TARGET)
      .map((entry) => join(TOOLCHAIN_TARGET, entry, 'debug', 'relayflowd'))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ??
    join(ROOT, 'kernel', 'target', 'debug', 'relayflowd')
  );
}

async function startDaemon(dataDir: string): Promise<void> {
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.push(daemon);
  const stderr: Buffer[] = [];
  daemon.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const socket = socketPathFor(dataDir);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(socket) && lstatSync(socket).isSocket()) {
      const ready = new JournalClient(socket, { requestTimeoutMs: 1_000 });
      try {
        await ready.connect();
        await ready.hello('node-spawn-live-readiness');
        return;
      } catch {
        /* Startup is still in progress. */
      } finally {
        ready.close();
      }
    }
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(
        `relayflowd exited before readiness: ${Buffer.concat(stderr).toString('utf8')}`,
      );
    }
    await delay(20);
  }
  throw new Error(`relayflowd did not bind ${socket} within 5000ms`);
}

async function connectClient(dataDir: string): Promise<JournalClient> {
  const client = new JournalClient(socketPathFor(dataDir), {
    requestTimeoutMs: 5_000,
  });
  clients.push(client);
  await client.connect();
  return client;
}

async function stopDaemon(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    daemon.once('exit', () => resolveExit()),
  );
  daemon.kill('SIGTERM');
  await exited;
}

async function waitForStep(
  client: JournalClient,
  runId: string,
  stepId: string,
  state: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await client.runGet(runId);
    if (snapshot.steps[stepId]?.state === state) return snapshot.steps[stepId];
    await delay(20);
  }
  throw new Error(`step ${stepId} did not reach ${state} within 10000ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
