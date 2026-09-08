// Attach-or-spawn for relayflowd (kernel/DAEMON-LIFECYCLE.md §3).
//
// Lifecycle is not transport, so none of this lives in journal-client.ts:
// putting spawn logic in the client would make every AgentWorker, tick runner
// and demo conjure daemons as a side effect of connecting. The client stays
// fail-closed with no retry and no spawn; this module only decides how the
// socket gets there.

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  checkDaemon,
  connectionPathFor,
  DAEMON_LOG_FILE,
  defaultDaemonLifecycleDeps,
  socketPathFor,
  type DaemonLifecycleDeps,
  type DaemonState,
} from './daemon-connection.js';
import { RelayflowdNotFoundError } from './relayflowd-path.js';

export * from './daemon-connection.js';

/** `relayflowd serve` lost the singleton lock — someone else is serving (§3). */
export const EXIT_ALREADY_SERVING = 3;

/** §3: matches ../relay's DETACHED_START_READY_TIMEOUT_MS. */
export const DEFAULT_START_TIMEOUT_MS = 10_000;
/** §3: matches the existing poll in scripts/run-local-workflow.mjs:64-71. */
export const START_POLL_INTERVAL_MS = 50;
/** How much of relayflowd.log a `daemon_start_failed` refusal quotes. */
const LOG_TAIL_BYTES = 4_096;

export interface EnsureDaemonOptions {
  /** `false` restores today's fail-closed behavior (`--no-spawn`). */
  spawn?: boolean;
  timeoutMs?: number;
}

/**
 * §3's CLI algorithm. Attach if something is serving; otherwise spawn
 * `relayflowd serve` detached and poll for it, bounded.
 *
 * The CLI never has to be clever here, and that is the load-bearing
 * simplification: because the singleton mutex lives in the daemon
 * (`flock` on `<data-dir>/relayflowd.lock`, §3), spawning when in doubt is
 * always safe. A child that loses the race exits `EXIT_ALREADY_SERVING`
 * having unlinked nothing, bound nothing and written nothing, and this loop
 * keeps polling until the winner publishes.
 *
 * The CLI never terminates a daemon — not one it found, and not one it
 * spawned.
 */
export async function ensureDaemon(
  dataDir: string,
  options: EnsureDaemonOptions = {},
  deps: DaemonLifecycleDeps = defaultDaemonLifecycleDeps,
): Promise<DaemonState> {
  const resolvedDataDir = resolve(dataDir);
  const maySpawn = options.spawn ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  const first = await checkDaemon(resolvedDataDir, deps);
  if (first.kind === 'attached' || first.kind === 'incompatible') return first;
  if (!maySpawn) {
    return {
      kind: 'unavailable',
      failure: 'daemon_unreachable',
      message: first.kind === 'stale' ? first.message : 'no connection file and no listening socket',
    };
  }

  // Only the corpse is removed, and only when nothing is serving and its pid
  // is gone (§2 row 1). The other stale verdicts leave the file alone on
  // purpose: a daemon mid-boot may be about to publish, and unlinking the
  // winner's file would strand this poll loop. The booting daemon sweeps
  // leftovers under the lock anyway (§1 step 3), which is the only place the
  // removal is provably safe.
  if (first.kind === 'stale' && first.reason === 'dead_pid_dead_socket') {
    deps.removeFile(connectionPathFor(resolvedDataDir));
  }

  let binary: string;
  try {
    binary = deps.resolveBinary();
  } catch (error) {
    return {
      kind: 'unavailable',
      failure: 'relayflowd_not_found',
      message: error instanceof RelayflowdNotFoundError || error instanceof Error
        ? error.message
        : 'relayflowd could not be located.',
    };
  }

  deps.makeDirectory(resolvedDataDir);
  const logPath = join(resolvedDataDir, DAEMON_LOG_FILE);
  const child = spawnDaemon(binary, resolvedDataDir, logPath, deps);
  return pollForDaemon(resolvedDataDir, child, logPath, timeoutMs, deps);
}

interface SpawnedDaemon {
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  error: Error | undefined;
}

/**
 * `detached: true` puts the child in its own session and process group. Both
 * consequences are required: it outlives this CLI, and a Ctrl-C sent to the
 * CLI's process group does not reach it.
 *
 * stdio never inherits the CLI's. A daemon holding the CLI's stdout would
 * interleave its own output with `flows run --json`'s single report object,
 * and would hold the pipe open after the CLI exits, hanging anything reading
 * it. stderr goes to `<data-dir>/relayflowd.log` so a failed start has
 * evidence to quote.
 */
function spawnDaemon(
  binary: string,
  dataDir: string,
  logPath: string,
  deps: DaemonLifecycleDeps,
): SpawnedDaemon {
  const state: SpawnedDaemon = { exit: undefined, error: undefined };
  const log = deps.openAppend(logPath);
  try {
    const child = deps.spawnProcess(binary, ['--data-dir', dataDir, 'serve'], {
      detached: true,
      stdio: ['ignore', 'ignore', log],
      env: process.env,
      cwd: process.cwd(),
    });
    child.once('error', (error: Error) => {
      state.error = error;
    });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      state.exit = { code, signal };
    });
    child.unref();
  } finally {
    // The child holds its own duplicate of this descriptor; keeping the
    // parent's copy open would leak one per invocation.
    deps.closeFd(log);
  }
  return state;
}

async function pollForDaemon(
  dataDir: string,
  child: SpawnedDaemon,
  logPath: string,
  timeoutMs: number,
  deps: DaemonLifecycleDeps,
): Promise<DaemonState> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if (child.error !== undefined) {
      return {
        kind: 'unavailable',
        failure: 'daemon_start_failed',
        message: `relayflowd could not be started: ${child.error.message}`,
      };
    }
    // §3 branch D.a: exit 3 means this child lost a benign race for the data
    // dir's lock. The winner is coming up. Keep polling; do not respawn, and
    // do not report failure.
    if (
      child.exit !== undefined
      && child.exit.code !== null
      && child.exit.code !== 0
      && child.exit.code !== EXIT_ALREADY_SERVING
    ) {
      return {
        kind: 'unavailable',
        failure: 'daemon_start_failed',
        message: `relayflowd exited ${child.exit.code} during startup.${logTail(logPath, deps)}`,
      };
    }

    const state = await checkDaemon(dataDir, deps);
    if (state.kind === 'attached' || state.kind === 'incompatible') return state;

    if (deps.now() >= deadline) {
      return {
        kind: 'unavailable',
        failure: 'daemon_start_timeout',
        message: `relayflowd did not start serving "${socketPathFor(dataDir)}" within ${timeoutMs}ms.`
          + logTail(logPath, deps),
      };
    }
    await deps.sleep(START_POLL_INTERVAL_MS);
  }
}

function logTail(logPath: string, deps: DaemonLifecycleDeps): string {
  const tail = deps.readTail(logPath, LOG_TAIL_BYTES).trim();
  return tail.length === 0 ? ` See "${logPath}".` : ` Last output in "${logPath}":\n${tail}`;
}
