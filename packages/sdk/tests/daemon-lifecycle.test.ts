// Unit cases for kernel/DAEMON-LIFECYCLE.md §§2-3, driven entirely through the
// injected `deps` seam: no file is read, no socket is opened, no process is
// spawned. The cases that need real processes — cold start, detachment, and
// the concurrent-invocation race — live in daemon-lifecycle-live.test.ts,
// because their property is enforced by the OS and cannot be stubbed.

import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDaemon,
  connectionPathFor,
  DEFAULT_START_TIMEOUT_MS,
  ensureDaemon,
  EXIT_ALREADY_SERVING,
  isProcessAlive,
  readConnectionFile,
  socketPathFor,
  type DaemonLifecycleDeps,
} from '../src/daemon-lifecycle.js';
import { RelayflowdNotFoundError } from '../src/relayflowd-path.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { runCli, type CliIo } from '../src/cli.js';

const DATA_DIR = '/tmp/flows-daemon-lifecycle-unit';
const SOCKET = socketPathFor(DATA_DIR);
const CONNECTION = connectionPathFor(DATA_DIR);
const BINARY = '/opt/relayflows/bin/relayflowd';

interface SpawnRecord {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  unrefCalled: boolean;
  child: EventEmitter;
}

interface World {
  files: Map<string, string>;
  alive: Set<number>;
  eperm: Set<number>;
  /** socket path -> protocol version answered by `hello`. */
  serving: Map<string, number>;
  spawns: SpawnRecord[];
  ticks: number;
  time: number;
  resolveBinary: () => string;
  onSpawn?: (record: SpawnRecord, world: World) => void;
  onTick?: (tick: number, world: World) => void;
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    files: new Map(),
    alive: new Set(),
    eperm: new Set(),
    serving: new Map(),
    spawns: [],
    ticks: 0,
    time: 1_000,
    resolveBinary: () => BINARY,
    ...overrides,
  };
}

function makeDeps(world: World): DaemonLifecycleDeps {
  return {
    readFile: (path) => world.files.get(path) ?? null,
    removeFile: (path) => {
      world.files.delete(path);
    },
    makeDirectory: () => {},
    openAppend: () => 7,
    closeFd: () => {},
    readTail: (path, bytes) => (world.files.get(path) ?? '').slice(-bytes),
    killProcess: (pid) => {
      if (world.eperm.has(pid)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      if (!world.alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
    spawnProcess: (command, args, options) => {
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      const record: SpawnRecord = { command, args, options, unrefCalled: false, child };
      child.unref = (): void => {
        record.unrefCalled = true;
      };
      world.spawns.push(record);
      // Deferred, like a real spawn: `child.on('error'|'exit')` is registered
      // by the caller only after `spawn()` returns, so a fake that emitted
      // synchronously would drop the event (and throw on an unhandled
      // 'error') rather than exercising the branch under test.
      queueMicrotask(() => world.onSpawn?.(record, world));
      return child as unknown as ChildProcess;
    },
    resolveBinary: () => world.resolveBinary(),
    probe: (socketPath) => Promise.resolve(
      world.serving.has(socketPath)
        ? { reachable: true, protocol: world.serving.get(socketPath)! }
        : { reachable: false },
    ),
    now: () => world.time,
    sleep: (ms) => {
      world.time += ms;
      world.ticks += 1;
      world.onTick?.(world.ticks, world);
      return Promise.resolve();
    },
  };
}

function publish(
  world: World,
  overrides: Partial<Record<string, unknown>> = {},
  dataDir = DATA_DIR,
): void {
  world.files.set(connectionPathFor(dataDir), JSON.stringify({
    socket_path: socketPathFor(dataDir),
    pid: 4242,
    version: '0.1.0',
    protocol: PROTOCOL_VERSION,
    started_at_ms: 1_757_308_800_123,
    ...overrides,
  }));
}

describe('readConnectionFile (DAEMON-LIFECYCLE.md §1, §2 steps 1-2)', () => {
  it('round-trips the documented shape and ignores unknown fields', () => {
    const world = makeWorld();
    publish(world, { future_field: 'ignored' });
    expect(readConnectionFile(DATA_DIR, makeDeps(world))).toEqual({
      socket_path: SOCKET,
      pid: 4242,
      version: '0.1.0',
      protocol: PROTOCOL_VERSION,
      started_at_ms: 1_757_308_800_123,
    });
  });

  it.each([
    ['absent', undefined],
    ['not JSON', '{'],
    ['an array', '[]'],
    ['missing socket_path', JSON.stringify({ pid: 1, version: '0', protocol: 0, started_at_ms: 1 })],
    ['an empty socket_path', JSON.stringify({ socket_path: '', pid: 1, version: '0', protocol: 0, started_at_ms: 1 })],
    ['pid 0', JSON.stringify({ socket_path: SOCKET, pid: 0, version: '0', protocol: 0, started_at_ms: 1 })],
    ['a fractional pid', JSON.stringify({ socket_path: SOCKET, pid: 1.5, version: '0', protocol: 0, started_at_ms: 1 })],
    ['a string protocol', JSON.stringify({ socket_path: SOCKET, pid: 1, version: '0', protocol: '0', started_at_ms: 1 })],
    ['started_at_ms 0', JSON.stringify({ socket_path: SOCKET, pid: 1, version: '0', protocol: 0, started_at_ms: 0 })],
  ])('reads %s as no file at all', (_label, content) => {
    const world = makeWorld();
    if (content !== undefined) world.files.set(CONNECTION, content);
    expect(readConnectionFile(DATA_DIR, makeDeps(world))).toBeNull();
  });
});

describe('isProcessAlive (§2 step 4)', () => {
  it('is true for a running pid and false for a reaped one', () => {
    const world = makeWorld({ alive: new Set([11]) });
    expect(isProcessAlive(11, makeDeps(world))).toBe(true);
    expect(isProcessAlive(12, makeDeps(world))).toBe(false);
  });

  // ../relay's isProcessRunning treats every throw as dead. Porting that would
  // spawn a second daemon over a live one owned by another user.
  it('is true on EPERM — the process exists, it is just another user\'s', () => {
    const world = makeWorld({ eperm: new Set([13]) });
    expect(isProcessAlive(13, makeDeps(world))).toBe(true);
  });

  it('refuses a nonsense pid without asking the OS', () => {
    const world = makeWorld();
    expect(isProcessAlive(0, makeDeps(world))).toBe(false);
    expect(isProcessAlive(-1, makeDeps(world))).toBe(false);
  });
});

describe('checkDaemon — the four cases of §2', () => {
  it('attaches when the pid is alive and the socket answers', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world);
    world.serving.set(SOCKET, PROTOCOL_VERSION);
    const state = await checkDaemon(DATA_DIR, makeDeps(world));
    expect(state).toMatchObject({ kind: 'attached', socketPath: SOCKET });
    expect(state.kind === 'attached' && state.warning).toBeUndefined();
  });

  // Row 2. The socket is the authority: something is serving, so attaching is
  // right and spawning would bind over a live daemon.
  it('attaches with a warning when the pid is dead but the socket answers', async () => {
    const world = makeWorld();
    publish(world);
    world.serving.set(SOCKET, PROTOCOL_VERSION);
    const state = await checkDaemon(DATA_DIR, makeDeps(world));
    expect(state.kind).toBe('attached');
    expect(state.kind === 'attached' && state.warning).toContain('4242');
  });

  // Row 3, the pid-reuse case: a live pid proves nothing.
  it('does not attach when the pid is alive but nothing answers the socket', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world);
    expect(await checkDaemon(DATA_DIR, makeDeps(world)))
      .toMatchObject({ kind: 'stale', reason: 'live_pid_dead_socket' });
  });

  it('calls a dead pid with a dead socket a corpse', async () => {
    const world = makeWorld();
    publish(world);
    expect(await checkDaemon(DATA_DIR, makeDeps(world)))
      .toMatchObject({ kind: 'stale', reason: 'dead_pid_dead_socket' });
  });

  // §2 step 3: a file whose socket_path points elsewhere is stale, not a
  // redirect. Accepting it is how a foreign artifact gets adopted.
  it('refuses a file naming a socket that is not this data dir\'s', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world, { socket_path: '/somewhere/else/relayflowd.sock' });
    world.serving.set('/somewhere/else/relayflowd.sock', PROTOCOL_VERSION);
    expect(await checkDaemon(DATA_DIR, makeDeps(world)))
      .toMatchObject({ kind: 'stale', reason: 'socket_path_mismatch' });
  });

  it('names the disagreement when this data dir IS served and the file points elsewhere', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world, { socket_path: '/somewhere/else/relayflowd.sock' });
    world.serving.set(SOCKET, PROTOCOL_VERSION);
    const state = await checkDaemon(DATA_DIR, makeDeps(world));
    expect(state).toMatchObject({ kind: 'attached', socketPath: SOCKET, connection: null });
    expect(state.kind === 'attached' && state.warning).toContain('/somewhere/else/relayflowd.sock');
  });

  it('reports an incompatible protocol from the file without a round trip', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world, { protocol: PROTOCOL_VERSION + 7 });
    const state = await checkDaemon(DATA_DIR, makeDeps(world));
    expect(state).toEqual({ kind: 'incompatible', protocol: PROTOCOL_VERSION + 7 });
    // No probe was needed: the file carries `protocol` precisely so a warm
    // start does not pay a round trip to learn about a mismatch.
    expect(world.serving.size).toBe(0);
  });

  it('reports an incompatible protocol answered by a live socket', async () => {
    const world = makeWorld();
    world.serving.set(SOCKET, PROTOCOL_VERSION + 1);
    expect(await checkDaemon(DATA_DIR, makeDeps(world)))
      .toEqual({ kind: 'incompatible', protocol: PROTOCOL_VERSION + 1 });
  });

  it('is absent with no file and no listener', async () => {
    expect(await checkDaemon(DATA_DIR, makeDeps(makeWorld()))).toEqual({ kind: 'absent' });
  });

  // §1's governing rule taken to its conclusion: a missing index is less
  // evidence against a serving socket than a stale one, and row 2 already
  // attaches over a stale one. Silently, because a missing file is the
  // ordinary state during boot and for any daemon built before it existed.
  it('attaches, without warning, to a serving socket that has published no connection file', async () => {
    const world = makeWorld();
    world.serving.set(SOCKET, PROTOCOL_VERSION);
    const state = await checkDaemon(DATA_DIR, makeDeps(world));
    expect(state).toEqual({ kind: 'attached', socketPath: SOCKET, connection: null });
  });

  // A live server that answers `hello` with a structured refusal is still a
  // live server. Calling it absent would spawn a second daemon over it.
  it('attaches to a socket whose hello refuses, leaving the refusal to the command', async () => {
    const world = makeWorld();
    const deps = { ...makeDeps(world), probe: () => Promise.resolve({ reachable: true }) };
    const state = await checkDaemon(DATA_DIR, deps);
    expect(state).toMatchObject({ kind: 'attached', socketPath: SOCKET });
  });

  it('does not spawn over a socket whose hello refuses', async () => {
    const world = makeWorld();
    const deps = { ...makeDeps(world), probe: () => Promise.resolve({ reachable: true }) };
    expect(await ensureDaemon(DATA_DIR, {}, deps)).toMatchObject({ kind: 'attached' });
    expect(world.spawns).toHaveLength(0);
  });
});

describe('ensureDaemon — attach or spawn (§3)', () => {
  // Test 8.
  it('warm start attaches with ZERO spawns', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world);
    world.serving.set(SOCKET, PROTOCOL_VERSION);

    const state = await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    expect(state.kind).toBe('attached');
    expect(world.spawns).toHaveLength(0);
  });

  // Test 9.
  it('cold start spawns exactly one daemon and attaches once it publishes', async () => {
    const world = makeWorld();
    world.onSpawn = (_record, w) => {
      // The daemon binds, then publishes. Two polls later, both are true.
      w.onTick = (tick, inner) => {
        if (tick !== 2) return;
        inner.serving.set(SOCKET, PROTOCOL_VERSION);
        inner.alive.add(9001);
        publish(inner, { pid: 9001 });
      };
    };

    const state = await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    expect(state).toMatchObject({ kind: 'attached', socketPath: SOCKET });
    expect(world.spawns).toHaveLength(1);
  });

  it('removes the corpse before spawning over a dead pid and dead socket', async () => {
    const world = makeWorld();
    publish(world, { pid: 4242 });
    world.onSpawn = (_record, w) => {
      w.onTick = (tick, inner) => {
        if (tick !== 1) return;
        inner.serving.set(SOCKET, PROTOCOL_VERSION);
        inner.alive.add(9002);
        publish(inner, { pid: 9002 });
      };
    };

    const state = await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    expect(world.spawns).toHaveLength(1);
    expect(state).toMatchObject({ kind: 'attached' });
    expect(readConnectionFile(DATA_DIR, makeDeps(world))?.pid).toBe(9002);
  });

  // The file of a daemon that may be mid-boot is NOT removed: unlinking the
  // winner's file would strand this poll loop with nothing to find.
  it('leaves the connection file alone when the pid is alive', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world);
    world.onSpawn = (_record, w) => {
      w.onTick = (tick, inner) => {
        if (tick === 1) inner.serving.set(SOCKET, PROTOCOL_VERSION);
      };
    };

    await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    expect(world.files.has(CONNECTION)).toBe(true);
  });

  // Test 14: never start a second daemon over a live incompatible one.
  it('refuses a protocol mismatch without spawning', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world, { protocol: 99 });

    expect(await ensureDaemon(DATA_DIR, {}, makeDeps(world)))
      .toEqual({ kind: 'incompatible', protocol: 99 });
    expect(world.spawns).toHaveLength(0);
  });

  // Test 16.
  it('spawns detached, with stdio that never inherits the CLI\'s, and unrefs', async () => {
    const world = makeWorld();
    world.onSpawn = (_record, w) => {
      w.onTick = (_tick, inner) => inner.serving.set(SOCKET, PROTOCOL_VERSION);
    };

    await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    const spawned = world.spawns[0]!;
    expect(spawned.command).toBe(BINARY);
    expect(spawned.args).toEqual(['--data-dir', DATA_DIR, 'serve']);
    expect(spawned.options.detached).toBe(true);
    const stdio = spawned.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(stdio[1]).toBe('ignore');
    expect(stdio[2]).toBe(7); // the appended <data-dir>/relayflowd.log fd
    expect(spawned.unrefCalled).toBe(true);
  });

  // Test 15's CLI half, in isolation: branch D.a. The process-level half is in
  // daemon-lifecycle-live.test.ts, where the race is real.
  it('keeps polling — and does not respawn — when its child loses the lock', async () => {
    const world = makeWorld();
    world.onSpawn = (record, w) => {
      // The child loses the flock and exits 3 immediately, having touched
      // nothing. The winner publishes two polls later.
      record.child.emit('exit', EXIT_ALREADY_SERVING, null);
      w.onTick = (tick, inner) => {
        if (tick !== 2) return;
        inner.serving.set(SOCKET, PROTOCOL_VERSION);
        inner.alive.add(5150);
        publish(inner, { pid: 5150 });
      };
    };

    const state = await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    expect(state).toMatchObject({ kind: 'attached' });
    expect(world.spawns).toHaveLength(1);
  });

  it('refuses when the child dies for any other reason, quoting the log', async () => {
    const world = makeWorld();
    world.files.set(join(DATA_DIR, 'relayflowd.log'), 'bind socket: Address already in use\n');
    world.onSpawn = (record) => record.child.emit('exit', 1, null);

    const state = await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    expect(state).toMatchObject({ kind: 'unavailable', failure: 'daemon_start_failed' });
    expect(state.kind === 'unavailable' && state.message).toContain('Address already in use');
  });

  it('refuses when the binary cannot be executed at all', async () => {
    const world = makeWorld();
    world.onSpawn = (record) => record.child.emit('error', new Error('spawn ENOENT'));

    expect(await ensureDaemon(DATA_DIR, {}, makeDeps(world)))
      .toMatchObject({ kind: 'unavailable', failure: 'daemon_start_failed' });
  });

  it('refuses, bounded, when the daemon never begins serving', async () => {
    const world = makeWorld();

    const state = await ensureDaemon(DATA_DIR, {}, makeDeps(world));

    expect(state).toMatchObject({ kind: 'unavailable', failure: 'daemon_start_timeout' });
    // Bounded by the deadline, not by luck: 10s of 50ms polls.
    expect(world.ticks).toBe(DEFAULT_START_TIMEOUT_MS / 50);
  });

  it('refuses without spawning when no relayflowd binary can be found', async () => {
    const world = makeWorld({
      resolveBinary: () => {
        throw new RelayflowdNotFoundError('no relayflowd anywhere', []);
      },
    });

    expect(await ensureDaemon(DATA_DIR, {}, makeDeps(world)))
      .toMatchObject({ kind: 'unavailable', failure: 'relayflowd_not_found' });
    expect(world.spawns).toHaveLength(0);
  });

  it('spawn: false refuses immediately and starts nothing', async () => {
    const world = makeWorld();

    expect(await ensureDaemon(DATA_DIR, { spawn: false }, makeDeps(world)))
      .toMatchObject({ kind: 'unavailable', failure: 'daemon_unreachable' });
    expect(world.spawns).toHaveLength(0);
    expect(world.ticks).toBe(0);
  });

  it('spawn: false still attaches to a daemon that is already serving', async () => {
    const world = makeWorld({ alive: new Set([4242]) });
    publish(world);
    world.serving.set(SOCKET, PROTOCOL_VERSION);

    expect(await ensureDaemon(DATA_DIR, { spawn: false }, makeDeps(world)))
      .toMatchObject({ kind: 'attached' });
  });
});

// Test 17: the lever that restores today's behavior exactly.
describe('--no-spawn and FLOWS_NO_SPAWN reproduce the old refusal', () => {
  const temporaryDirectories: string[] = [];
  // The observer-link fallback added in Task 3 reads
  // `${AGENT_RELAY_HOME}/workspaces.json`; on a developer machine where
  // agent-relay has been logged in that file exists and holds a real
  // workspace key, so `runCli` would fire a mint whose 404/network error
  // appends an `[observer]` line to stderr and displaces the byte-for-byte
  // daemon_unreachable assertion below. Suppress the mint for the whole
  // describe block via FLOWS_NO_OBSERVER=1 -- the daemon-unreachable path
  // this suite covers is orthogonal to observer-link resolution.
  let previousNoObserver: string | undefined;
  beforeAll(() => {
    previousNoObserver = process.env['FLOWS_NO_OBSERVER'];
    process.env['FLOWS_NO_OBSERVER'] = '1';
  });
  afterAll(() => {
    if (previousNoObserver === undefined) delete process.env['FLOWS_NO_OBSERVER'];
    else process.env['FLOWS_NO_OBSERVER'] = previousNoObserver;
  });
  afterEach(() => {
    delete process.env['FLOWS_NO_SPAWN'];
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      stdout,
      stderr,
    };
  }

  function absentDataDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'flows-no-spawn-'));
    temporaryDirectories.push(directory);
    return join(directory, 'absent');
  }

  const FLOW = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'testdata', 'hello-deterministic.flow.yaml',
  );

  it('--no-spawn refuses with the byte-for-byte daemon_unreachable message', async () => {
    const dataDir = absentDataDir();
    const output = capture();

    const code = await runCli(['run', '--no-spawn', '--data-dir', dataDir, FLOW], output.io);

    expect(code).toBe(2);
    // Byte for byte the message this branch emitted before attach-or-spawn
    // existed; the preflight warnings ahead of it are unchanged too.
    expect(output.stderr.at(-1)).toBe(
      `REFUSED [daemon_unreachable] No compatible relayflowd is listening at "${socketPathFor(dataDir)}". `
        + `Start it with: relayflowd --data-dir ${JSON.stringify(dataDir)} serve`,
    );
  });

  it('FLOWS_NO_SPAWN=1 does the same for a whole environment', async () => {
    process.env['FLOWS_NO_SPAWN'] = '1';
    const dataDir = absentDataDir();
    const output = capture();

    const code = await runCli(['resume', '--data-dir', dataDir, '01JABCDEFGHJKMNPQRSTVWXYZ0'], output.io);

    expect(code).toBe(2);
    expect(output.stderr.join('\n')).toContain('REFUSED [daemon_unreachable]');
  });

  it('refuses --no-spawn on check, which never opens a socket', async () => {
    const output = capture();
    const code = await runCli(['check', '--no-spawn', FLOW], output.io);
    expect(code).toBe(2);
    expect(output.stderr.join('\n')).toContain('REFUSED [invalid_invocation]');
  });

  it('refuses a repeated --no-spawn', async () => {
    const output = capture();
    const code = await runCli(['run', '--no-spawn', '--no-spawn', FLOW], output.io);
    expect(code).toBe(2);
    expect(output.stderr.join('\n')).toContain('REFUSED [invalid_invocation]');
  });
});
