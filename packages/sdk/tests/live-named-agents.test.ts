import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync, readFileSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { socketPathFor } from '../src/daemon-connection.js';
import { JournalClient } from '../src/journal-client.js';
import { AgentWorker } from '../src/worker.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';

const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN']
  ?? fileURLToPath(new URL('../../../kernel/target/debug/relayflowd', import.meta.url)));
const temporaryDirectories: string[] = [];
const daemons: ChildProcess[] = [];
const clients: JournalClient[] = [];
beforeAll(() => {
  try { accessSync(RELAYFLOWD, constants.X_OK); }
  catch {
    throw new Error(`Build this checkout's daemon and set RELAYFLOWD_BIN to it: ${RELAYFLOWD}`);
  }
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('named agents against a live kernel', () => {
  it('dispatches two distinct named agents declared in the flow header', async () => {
    // Distinct binaries echo their identity and received model to detect misdispatch.
    const directory = temporaryDirectory('flows-live-named-agents-');
    const dataDir = join(directory, 'data');

    function stubCli(label: string): string {
      const cli = join(directory, `${label}-cli`);
      writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  require('node:fs').appendFileSync(${JSON.stringify(join(directory, 'probes.jsonl'))}, JSON.stringify({ cli: ${JSON.stringify(label)}, model: process.env.RELAYFLOW_MODEL }) + '\\n');
  process.exit(0);
}
if (process.argv[2] !== '--relayflows-adapter-v1') process.exit(9);
process.stdout.write('relayflows-agent-cli-v1\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.trim() === '') process.exit(0);
  const request = JSON.parse(input);
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write(JSON.stringify({ cli: ${JSON.stringify(label)}, model: request.model, task: request.instruction }));
});
`);
      chmodSync(cli, 0o755);
      return cli;
    }
    const reviewerCli = stubCli('reviewer');
    const fixerCli = stubCli('fixer');
    // No project-level `cli` declared — both steps must resolve purely
    // through the header's named declarations, proving `cli`/`agent` reached
    // the submitted spec rather than silently falling back to a project
    // default. `models` allowlists both declared models so preflight's
    // model-registry check (preflight.ts's unknownModelDiagnostics) doesn't
    // refuse first; the custom-wrapper model-scoped probe (cli-adapter.ts's
    // modelReadinessProbe, "relayflows-wrapper-v1" branch) just re-invokes
    // the same `auth status` the stub CLIs above already answer.
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ models: ['model-a', 'model-b'] }));
    await startDaemon(dataDir);

    const client = await connectClient(dataDir);
    await client.hello('live-sdk-named-agents-worker');
    const worker = new AgentWorker(client, {
      workerId: 'live-sdk-named-agents-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    await worker.attach();

    const runClient = await connectClient(dataDir);
    await runClient.hello('live-sdk-named-agents-run');
    const captured: Record<string, { cli: string; model: string; task: string }> = {};
    const handle = flow('named-agents', {
      agents: {
        reviewer: { cli: reviewerCli, model: 'model-a' },
        fixer: { cli: fixerCli, model: 'model-b' },
        // A valid unused alias is checked without dispatch or duplicate probes.
        unused: { cli: reviewerCli, model: 'model-a' },
      },
    }, async (f) => {
      captured['reviewer'] = JSON.parse((await f.agent('reviewer', { task: 'review the diff' })).summary);
      captured['fixer'] = JSON.parse((await f.agent('fixer', { task: 'fix what reviewer found' })).summary);
      // Step-level cli/model must win over the named declaration's own —
      // selecting "reviewer" but overriding onto fixer's cli/model proves
      // the override is genuinely applied, not just tolerated as a no-op.
      captured['override'] = JSON.parse((await f.agent('reviewer', {
        task: 'override', cli: fixerCli, model: 'model-b',
      })).summary);
      captured['modelOnly'] = JSON.parse((await f.agent('reviewer', {
        task: 'model-only', model: 'model-b',
      })).summary);
      captured['cliOnly'] = JSON.parse((await f.agent('reviewer', {
        task: 'cli-only', cli: fixerCli,
      })).summary);
      f.done('success');
    });

    let result: Awaited<ReturnType<typeof executeAuthoredFlow>>;
    try {
      result = await executeAuthoredFlow(handle, runClient, undefined, {
        flowPath: join(directory, 'named-agents.flow.ts'),
      });
    } finally {
      await worker.close();
    }

    expect(captured['modelOnly']).toEqual({ cli: 'reviewer', model: 'model-b', task: 'model-only' });
    expect(captured['cliOnly']).toEqual({ cli: 'fixer', model: 'model-a', task: 'cli-only' });
    const probes = readFileSync(join(directory, 'probes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    // Each distinct CLI/model pair gets one model-scoped readiness probe.
    // Selecting a declaration again (including the unused alias) reuses readiness.
    expect(probes).toHaveLength(4);
    for (const cli of ['reviewer', 'fixer']) {
      for (const model of ['model-a', 'model-b']) {
        expect(probes.filter(probe => probe.cli === cli && probe.model === model)).toHaveLength(1);
      }
    }
    expect(result.completionReason).toBe('success');
    expect(captured['reviewer']).toEqual({ cli: 'reviewer', model: 'model-a', task: 'review the diff' });
    expect(captured['fixer']).toEqual({ cli: 'fixer', model: 'model-b', task: 'fix what reviewer found' });
    expect(captured['override']).toEqual({ cli: 'fixer', model: 'model-b', task: 'override' });
  });

});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function startDaemon(dataDir: string): Promise<ChildProcess> {
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.push(daemon);
  const stderr: Buffer[] = [];
  daemon.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const socket = socketPathFor(dataDir);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(socket) && lstatSync(socket).isSocket()) return daemon;
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`relayflowd exited before binding ${socket}: ${Buffer.concat(stderr).toString('utf8')}`);
    }
    await delay(20);
  }
  throw new Error(`relayflowd did not bind ${socket} within 5000ms`);
}

async function stopDaemon(daemon: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => daemon.once('exit', () => resolveExit()));
  daemon.kill(signal);
  await exited;
}

async function connectClient(dataDir: string): Promise<JournalClient> {
  const client = new JournalClient(socketPathFor(dataDir), { requestTimeoutMs: 5_000 });
  clients.push(client);
  await client.connect();
  return client;
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
