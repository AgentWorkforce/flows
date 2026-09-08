// The attach-or-spawn cases that need real processes
// (kernel/DAEMON-LIFECYCLE.md §6 tests 7, 15, and the detachment half of 16).
//
// These drive the BUILT `flows` CLI as a subprocess against a stub relayflowd
// (tests/fixtures/stub-relayflowd.mjs) reached through `RELAYFLOWD_BIN`. A
// stub rather than the kernel binary because the property under test is the
// CLI's: whether it spawns once, whether the daemon outlives it, whether two
// concurrent invocations end with one socket owner. The daemon-side guarantees
// the stub imitates — the `flock`, the publish-after-listen ordering, the
// signal handlers — are the kernel implementation's to prove in `cargo test`
// (DAEMON-LIFECYCLE.md §6 tests 1-6).

import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonConnection } from '../src/daemon-lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const BUILT_CLI = join(ROOT, 'packages', 'sdk', 'dist', 'cli.js');
const FLOW = join(ROOT, 'testdata', 'hello-deterministic.flow.yaml');
const STUB = join(HERE, 'fixtures', 'stub-relayflowd.mjs');

const temporaryDirectories: string[] = [];
const startedPids: number[] = [];

beforeAll(() => {
  if (!existsSync(BUILT_CLI)) {
    throw new Error(`missing built CLI at ${BUILT_CLI}; run \`npm run build\` in packages/sdk`);
  }
});

afterEach(() => {
  for (const pid of startedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone; that is the expected state for most cases.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * `RELAYFLOWD_BIN` must name an executable (§3.1 anchor 1), so the stub is
 * reached through a one-line launcher rather than being invoked as `node
 * stub.mjs`.
 */
function stubLauncher(directory: string): string {
  const launcher = join(directory, 'relayflowd');
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

function cliEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

function invokeCli(args: readonly string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BUILT_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
}

function invokeCliAsync(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BUILT_CLI, ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function connectionFile(dataDir: string): DaemonConnection {
  return JSON.parse(readFileSync(join(dataDir, 'connection.json'), 'utf8')) as DaemonConnection;
}

/** The pid the stub daemon recorded in `<data-dir>/relayflowd.lock`. */
function lockHolder(dataDir: string): number {
  return Number.parseInt(readFileSync(join(dataDir, 'relayflowd.lock'), 'utf8').trim(), 10);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function traceLines(tracePath: string, verb: string): string[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${verb} `));
}

describe('flows run against a data dir with no daemon (§6 test 7)', () => {
  it('cold start spawns exactly one daemon, the run succeeds, and the daemon outlives the CLI', () => {
    const directory = workspace('flows-cold-start-');
    const dataDir = join(directory, 'data');
    const trace = join(directory, 'trace.log');

    const result = invokeCli(['run', '--data-dir', dataDir, FLOW], cliEnv({
      RELAYFLOWD_BIN: stubLauncher(directory),
      STUB_TRACE: trace,
    }));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('completionReason: success');
    expect(traceLines(trace, 'start')).toHaveLength(1);
    expect(traceLines(trace, 'serving')).toHaveLength(1);

    // Detached, not merely backgrounded: the CLI has already exited, and the
    // daemon it started is still serving.
    const connection = connectionFile(dataDir);
    startedPids.push(connection.pid);
    expect(connection.socket_path).toBe(join(dataDir, 'relayflowd.sock'));
    expect(isAlive(connection.pid)).toBe(true);
  });

  it('polls, bounded, for a daemon that holds the lock before it binds', () => {
    const directory = workspace('flows-slow-listen-');
    const dataDir = join(directory, 'data');
    const trace = join(directory, 'trace.log');

    const started = Date.now();
    const result = invokeCli(['run', '--data-dir', dataDir, FLOW], cliEnv({
      RELAYFLOWD_BIN: stubLauncher(directory),
      STUB_TRACE: trace,
      STUB_LISTEN_DELAY_MS: '900',
    }));

    expect(result.status, result.stderr).toBe(0);
    // It waited rather than refusing, and it waited by polling rather than by
    // spawning again.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(traceLines(trace, 'start')).toHaveLength(1);
    startedPids.push(connectionFile(dataDir).pid);
  });

  // The governing rule made observable: a daemon that is serving but has not
  // published its index yet is attached to on the socket's authority. This is
  // also what lets `flows run` work against a relayflowd built before the
  // connection file existed.
  it('attaches to a serving daemon that has not published a connection file', () => {
    const directory = workspace('flows-no-index-');
    const dataDir = join(directory, 'data');

    const result = invokeCli(['run', '--data-dir', dataDir, FLOW], cliEnv({
      RELAYFLOWD_BIN: stubLauncher(directory),
      STUB_NO_CONNECTION_FILE: '1',
    }));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('completionReason: success');
    expect(existsSync(join(dataDir, 'connection.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'relayflowd.sock'))).toBe(true);
    startedPids.push(lockHolder(dataDir));
  });

  it('a second run attaches to the daemon the first one started, spawning nothing', () => {
    const directory = workspace('flows-warm-start-');
    const dataDir = join(directory, 'data');
    const trace = join(directory, 'trace.log');
    const env = cliEnv({ RELAYFLOWD_BIN: stubLauncher(directory), STUB_TRACE: trace });

    expect(invokeCli(['run', '--data-dir', dataDir, FLOW], env).status).toBe(0);
    const first = connectionFile(dataDir);
    startedPids.push(first.pid);

    const second = invokeCli(['run', '--data-dir', dataDir, FLOW], env);

    expect(second.status, second.stderr).toBe(0);
    // Warm start: not one extra process was launched, let alone one that bound.
    expect(traceLines(trace, 'start')).toHaveLength(1);
    expect(connectionFile(dataDir).pid).toBe(first.pid);
  });

  it('detects a stale connection file left by a hard kill and starts a fresh daemon', () => {
    const directory = workspace('flows-stale-file-');
    const dataDir = join(directory, 'data');
    const env = cliEnv({ RELAYFLOWD_BIN: stubLauncher(directory) });

    expect(invokeCli(['run', '--data-dir', dataDir, FLOW], env).status).toBe(0);
    const killed = connectionFile(dataDir);

    // SIGKILL runs no handler, so the file and the socket inode both survive
    // their daemon — by construction (§1). That residue is what §2 detects.
    process.kill(killed.pid, 'SIGKILL');
    waitUntilDead(killed.pid);
    expect(existsSync(join(dataDir, 'connection.json'))).toBe(true);
    expect(connectionFile(dataDir).pid).toBe(killed.pid);

    const second = invokeCli(['run', '--data-dir', dataDir, FLOW], env);

    expect(second.status, second.stderr).toBe(0);
    const fresh = connectionFile(dataDir);
    startedPids.push(fresh.pid);
    expect(fresh.pid).not.toBe(killed.pid);
    expect(isAlive(fresh.pid)).toBe(true);
  });
});

describe('concurrent invocations against one empty data dir (§6 test 15)', () => {
  it('ends with exactly one daemon owning the socket, and both runs succeed', async () => {
    const directory = workspace('flows-race-');
    const dataDir = join(directory, 'data');
    const trace = join(directory, 'trace.log');
    // The listen delay is what makes the race real rather than lucky: nothing
    // is serving and nothing is published for 600ms, so the second CLI's first
    // `checkDaemon` still sees an empty data dir and both decide to spawn.
    // The daemons then genuinely contend for the data dir's lock.
    const env = cliEnv({
      RELAYFLOWD_BIN: stubLauncher(directory),
      STUB_TRACE: trace,
      STUB_LISTEN_DELAY_MS: '600',
    });

    const [first, second] = await Promise.all([
      invokeCliAsync(['run', '--data-dir', dataDir, FLOW], env),
      invokeCliAsync(['run', '--data-dir', dataDir, FLOW], env),
    ]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);

    // The property: however many daemons were launched, exactly one ever bound
    // the socket, and every other one exited 3 without touching anything.
    const started = traceLines(trace, 'start');
    const serving = traceLines(trace, 'serving');
    const lost = traceLines(trace, 'lost');
    // Both CLIs really did spawn: without this the rest of the case could pass
    // vacuously on a run where only one of them ever tried.
    expect(started).toHaveLength(2);
    expect(serving).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const connection = connectionFile(dataDir);
    startedPids.push(connection.pid);
    expect(serving[0]).toBe(`serving ${connection.pid}`);
    expect(isAlive(connection.pid)).toBe(true);
  }, 60_000);
});

describe('refusals from a spawn that cannot produce a daemon', () => {
  it('names relayflowd_not_found rather than falling through to PATH', () => {
    const directory = workspace('flows-no-binary-');

    const result = invokeCli(['run', '--data-dir', join(directory, 'data'), FLOW], cliEnv({
      RELAYFLOWD_BIN: join(directory, 'not-executable'),
    }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('REFUSED [relayflowd_not_found]');
    expect(result.stderr).toContain('RELAYFLOWD_BIN');
  });

  it('names daemon_start_failed and quotes the daemon log when startup dies', () => {
    const directory = workspace('flows-start-failed-');
    const dataDir = join(directory, 'data');

    const result = invokeCli(['run', '--data-dir', dataDir, FLOW], cliEnv({
      RELAYFLOWD_BIN: stubLauncher(directory),
      STUB_STARTUP_EXIT: '1',
    }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('REFUSED [daemon_start_failed]');
    expect(result.stderr).toContain('STUB_STARTUP_EXIT');
    expect(readFileSync(join(dataDir, 'relayflowd.log'), 'utf8')).toContain('refusing to start');
  });

  it('refuses a daemon speaking another protocol version instead of binding over it', () => {
    const directory = workspace('flows-protocol-');
    const dataDir = join(directory, 'data');
    const env = cliEnv({ RELAYFLOWD_BIN: stubLauncher(directory), STUB_PROTOCOL: '77' });

    const result = invokeCli(['run', '--data-dir', dataDir, FLOW], env);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('REFUSED [daemon_protocol_mismatch]');
    if (existsSync(join(dataDir, 'connection.json'))) {
      startedPids.push(connectionFile(dataDir).pid);
    }
  });
});

/** A synchronous wait, so the assertion after it observes a settled world. */
function waitUntilDead(pid: number): void {
  const deadline = Date.now() + 5_000;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (isAlive(pid) && Date.now() < deadline) Atomics.wait(idle, 0, 0, 20);
  if (isAlive(pid)) throw new Error(`pid ${pid} did not exit`);
}
