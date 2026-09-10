// Reading and validating relayflowd's connection file, and deciding whether
// anything is actually serving a data dir (kernel/DAEMON-LIFECYCLE.md §§1-2).
//
// Split from daemon-lifecycle.ts along the same seam ../relay uses between
// broker-connection.ts and broker-lifecycle.ts: this file answers "what is
// there?", that one answers "put something there". Neither approaches the
// 500-line smell in AGENTS.md rule 1.
//
// The governing rule, from §1: **the socket is the authority;
// `connection.json` is an index over it.** A file is never believed on its
// own. Every "attach" in this module is backed by a `hello` that a live
// daemon answered on the socket path recomputed from `--data-dir` — never by
// what a file says about itself.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JournalClient, JournalProtocolError } from './journal-client.js';
import { PROTOCOL_VERSION } from './protocol.js';
import {
  defaultRelayflowdPathDeps,
  resolveRelayflowdBinary,
} from './relayflowd-path.js';

/**
 * The `hello` probe runs before every command, so it must be short. §4 gives
 * `connect()` the same bound for the same reason: a listener that accepts and
 * never answers must not hold the CLI for the 30s request default.
 */
export const PROBE_TIMEOUT_MS = 2_000;

export const CONNECTION_FILE = 'connection.json';
export const SOCKET_FILE = 'relayflowd.sock';
export const DAEMON_LOG_FILE = 'relayflowd.log';

/** `<data-dir>/connection.json`, exactly the shape in §1. */
export interface DaemonConnection {
  socket_path: string;
  pid: number;
  version: string;
  protocol: number;
  started_at_ms: number;
}

/** Why an existing `connection.json` was not believed (§2's four cases). */
export type StaleReason =
  /** §2 step 3: the file names a socket that is not this data dir's. */
  | 'socket_path_mismatch'
  /** §2 row 1: nothing serving, and the pid is gone. A corpse. */
  | 'dead_pid_dead_socket'
  /** §2 row 3: pid alive but nothing answers — mid-boot, or a reused pid. */
  | 'live_pid_dead_socket';

/** Closed refusal taxonomy for the lifecycle itself. Mirrored in failure-kinds.ts. */
export type DaemonFailureKind =
  | 'daemon_unreachable'
  | 'relayflowd_not_found'
  | 'daemon_start_failed'
  | 'daemon_start_timeout';

export type DaemonState =
  | { kind: 'attached'; socketPath: string; connection: DaemonConnection | null; warning?: string }
  | { kind: 'absent' }
  | { kind: 'stale'; reason: StaleReason; message: string }
  | { kind: 'incompatible'; protocol: number }
  /**
   * `ensureDaemon` only. §4's sketch types `ensureDaemon` as returning a
   * `DaemonState` while §3 branches D.b/D.d refuse with kinds that union has
   * no member for; this is that refusal channel, kept as data rather than a
   * thrown error so it reads like the rest of cli/run.ts.
   */
  | { kind: 'unavailable'; failure: DaemonFailureKind; message: string };

/** A probe of the socket itself — the only check that proves something serves. */
export interface SocketProbe {
  reachable: boolean;
  /**
   * The protocol the daemon reported. Absent when something is demonstrably
   * serving the socket but would not say — see `probeSocket`.
   */
  protocol?: number;
}

/**
 * Injectable seams, following the `deps` pattern of the ../relay file this is
 * modelled on. Unit tests reach no real filesystem and spawn no process.
 */
export interface DaemonLifecycleDeps {
  readFile(path: string): string | null;
  removeFile(path: string): void;
  makeDirectory(path: string): void;
  openAppend(path: string): number;
  closeFd(fd: number): void;
  readTail(path: string, bytes: number): string;
  killProcess(pid: number, signal: number): void;
  spawnProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  resolveBinary(): string;
  probe(socketPath: string, timeoutMs: number): Promise<SocketProbe>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const defaultDaemonLifecycleDeps: DaemonLifecycleDeps = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  removeFile(path) {
    rmSync(path, { force: true });
  },
  makeDirectory(path) {
    mkdirSync(path, { recursive: true });
  },
  openAppend: (path) => openSync(path, 'a'),
  closeFd: (fd) => closeSync(fd),
  readTail(path, bytes) {
    try {
      const content = readFileSync(path, 'utf8');
      return content.length <= bytes ? content : content.slice(-bytes);
    } catch {
      return '';
    }
  },
  killProcess: (pid, signal) => {
    process.kill(pid, signal);
  },
  spawnProcess: (command, args, options) => spawn(command, args as string[], options),
  resolveBinary: () => resolveRelayflowdBinary(defaultRelayflowdPathDeps),
  probe: (socketPath, timeoutMs) => probeSocket(socketPath, timeoutMs),
  now: () => Date.now(),
  // Deliberately NOT unref'd: an unref'd timer lets Node exit the event loop
  // mid-poll, which would abandon the await and end the CLI with no report.
  // The deadline in `pollForDaemon` is what bounds this wait.
  sleep: (ms) => new Promise((done) => {
    setTimeout(done, ms);
  }),
};

/**
 * Derive the daemon socket path from the data dir.
 *
 * The socket lives outside the data dir at a short hashed path so that a deep
 * working directory cannot push the full socket path past `SUN_LEN` (~104
 * bytes on macOS, ~108 on Linux) — the first-run papercut in #262. Anti-hijack
 * still holds because the daemon derives the same path from the same input;
 * this function and Rust's `crate::socket_path::derive_socket_path` must stay
 * in lockstep. Both use `resolve()` / `std::path::absolute` (lexical, no
 * symlink resolution) so `/var` vs macOS's `/private/var` can never diverge.
 *
 * `SOCKET_FILE` is retained as the exported constant name for compatibility,
 * but is no longer the *entire* socket filename — see the derivation below.
 */
export function socketPathFor(dataDir: string): string {
  const absolute = resolve(dataDir);
  // 12 hex chars = 6 bytes of SHA-256. Enough separation between data dirs on
  // one machine, small enough to leave headroom under SUN_LEN.
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 12);
  return join(runtimeDir(), `relayflowd-${hash}.sock`);
}

function runtimeDir(): string {
  // XDG first (Linux, typically `/run/user/<uid>/`, ~14 chars — the shortest
  // per-user private option). TMPDIR next (macOS, `/var/folders/xx/YYY/T/`,
  // per-user private). Only fall back to os.tmpdir() when neither is set.
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (xdg && xdg.length > 0) return xdg;
  const tmp = process.env['TMPDIR'];
  if (tmp && tmp.length > 0) return tmp;
  return tmpdir();
}

export function connectionPathFor(dataDir: string): string {
  return join(resolve(dataDir), CONNECTION_FILE);
}

/**
 * §2 steps 1-2. Absent, unparseable, and wrongly-typed all read the same:
 * `null`. Unknown fields are ignored, so adding one later is not breaking.
 * The `socket_path` agreement check is §2 step 3 and lives in `checkDaemon`,
 * which knows the data dir the path must agree with.
 */
export function readConnectionFile(
  dataDir: string,
  deps: DaemonLifecycleDeps = defaultDaemonLifecycleDeps,
): DaemonConnection | null {
  const raw = deps.readFile(connectionPathFor(dataDir));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const socketPath = record['socket_path'];
  const pid = record['pid'];
  const version = record['version'];
  const protocol = record['protocol'];
  const startedAtMs = record['started_at_ms'];
  if (typeof socketPath !== 'string' || socketPath.length === 0) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof version !== 'string') return null;
  if (typeof protocol !== 'number' || !Number.isInteger(protocol)) return null;
  if (typeof startedAtMs !== 'number' || !Number.isInteger(startedAtMs) || startedAtMs <= 0) {
    return null;
  }
  return {
    socket_path: socketPath,
    pid,
    version,
    protocol,
    started_at_ms: startedAtMs,
  };
}

/**
 * §2 step 4. **`EPERM` means alive** — the process exists and is owned by
 * another user. ../relay's `isProcessRunning` treats every throw as dead,
 * which would spawn a second daemon over a live one owned by someone else.
 * That bug is not ported.
 */
export function isProcessAlive(
  pid: number,
  deps: DaemonLifecycleDeps = defaultDaemonLifecycleDeps,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    deps.killProcess(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * §2 step 5. Connect, `hello`, close. A refused connection, a connect timeout,
 * or a `hello` that does not answer inside the probe timeout is a failed
 * probe. This is the only check that proves something is *serving*.
 *
 * A `hello` that answers with a structured REFUSAL is not a failed probe. §2
 * step 5 was written against silence, and silence is what it must catch;
 * something that returns `{ ok: false, error: ... }` is unmistakably a live
 * server, and calling it absent would spawn a second daemon over it — the one
 * outcome this whole design exists to prevent. It is reported as reachable
 * with no protocol, which leaves the refusal to be reported by the command's
 * own `hello`, where it becomes a `protocol_error` naming the server's code
 * instead of a lifecycle guess.
 */
export async function probeSocket(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SocketProbe> {
  const client = new JournalClient(socketPath, {
    connectTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs,
  });
  try {
    await client.connect();
    const hello = await client.hello('flows-probe');
    return { reachable: true, protocol: hello.protocol };
  } catch (error) {
    return error instanceof JournalProtocolError ? { reachable: true } : { reachable: false };
  } finally {
    client.close();
  }
}

/**
 * §2, decided as one function. The socket is probed at the path recomputed
 * from `--data-dir`, never at the path the file names, so a file that points
 * elsewhere is stale rather than a redirect.
 *
 * One addition to §2's table, licensed by §1's governing rule: a socket that
 * answers `hello` with **no** connection file at all is an attach, not an
 * absence. §2 row 2 already attaches on the socket's authority over a file
 * describing a dead pid; a missing file is strictly less evidence against the
 * socket than a stale one. It also keeps the CLI honest about a daemon started
 * from a build that predates the connection file.
 */
export async function checkDaemon(
  dataDir: string,
  deps: DaemonLifecycleDeps = defaultDaemonLifecycleDeps,
): Promise<DaemonState> {
  const socketPath = socketPathFor(dataDir);
  const connection = readConnectionFile(dataDir, deps);
  const agrees = connection !== null && connection.socket_path === socketPath;

  // §2's reason for carrying `protocol` in the file: an incompatible daemon
  // owning this data dir is decided without a round trip.
  if (agrees && connection.protocol !== PROTOCOL_VERSION) {
    return { kind: 'incompatible', protocol: connection.protocol };
  }

  const probe = await deps.probe(socketPath, PROBE_TIMEOUT_MS);
  if (probe.reachable) {
    // Only a KNOWN mismatch refuses. An undefined protocol means the daemon
    // is serving but declined to say, which the command's own `hello` will
    // report far better than this function could.
    if (probe.protocol !== undefined && probe.protocol !== PROTOCOL_VERSION) {
      return { kind: 'incompatible', protocol: probe.protocol };
    }
    if (!agrees) {
      // No warning when the file is merely ABSENT: that is the ordinary state
      // during a daemon's boot window, and the ordinary state of any daemon
      // built before the connection file existed. A file that CONTRADICTS the
      // socket is a different matter and is named.
      const mismatch = connection === null
        ? undefined
        : `"${connectionPathFor(dataDir)}" names a different socket (${connection.socket_path}); attaching to "${socketPath}" instead.`;
      return {
        kind: 'attached',
        socketPath,
        connection: null,
        ...(mismatch === undefined ? {} : { warning: mismatch }),
      };
    }
    // §2 row 2: dead pid, live socket. Something is serving; do not spawn.
    // Binding over a live daemon is the corruption this design prevents.
    const warning = isProcessAlive(connection.pid, deps)
      ? undefined
      : `${CONNECTION_FILE} names pid ${connection.pid}, which is not running, but "${socketPath}" is serving. Attaching to the socket.`;
    return {
      kind: 'attached',
      socketPath,
      connection,
      ...(warning === undefined ? {} : { warning }),
    };
  }

  // Nothing is serving.
  if (connection === null) return { kind: 'absent' };
  if (!agrees) {
    return {
      kind: 'stale',
      reason: 'socket_path_mismatch',
      message: `${CONNECTION_FILE} names socket "${connection.socket_path}", not "${socketPath}".`,
    };
  }
  // §2 row 3: a live pid proves nothing — a daemon mid-boot and an unrelated
  // process that inherited the pid look identical from here, and neither is
  // an attach. Spawning is safe in both cases because the daemon holds the
  // mutex (§3): a redundant child loses the flock and exits 3.
  return isProcessAlive(connection.pid, deps)
    ? {
      kind: 'stale',
      reason: 'live_pid_dead_socket',
      message: `pid ${connection.pid} is alive but "${socketPath}" is not accepting connections.`,
    }
    : {
      kind: 'stale',
      reason: 'dead_pid_dead_socket',
      message: `pid ${connection.pid} is gone and "${socketPath}" is not accepting connections.`,
    };
}

