import type { ChildProcess } from 'node:child_process';

/**
 * Grace between the graceful signal and the force kill. A tree that ignores
 * `SIGTERM` still has to go: it is holding the inherited stdio pipes that keep
 * the `flows run` event loop alive long after the step itself has settled.
 */
export const FORCE_KILL_DELAY_MS = 1_000;

/**
 * The one stop path for a spawned agent process.
 *
 * There are three stops — lease abort, execution timeout, and protocol
 * `terminate` — and the decision they share is whether a signal must address
 * the process GROUP or the direct child. That decision used to be made at each
 * call site, which meant it was made once and omitted twice: only abort killed
 * the group, so a timeout or a protocol violation left the grandchildren alive
 * holding the pipes they inherited. The step Promise settled; `flows run` never
 * exited, because those pipe handles stay open and referenced.
 *
 * So the decision lives here instead, bound once at the spawn site. A call site
 * chooses only the FORCE of the stop, never its REACH.
 */
export interface ChildStop {
  /** Stop the tree now, unconditionally. */
  kill(): void;
  /** Ask the tree to stop, then force whatever is still alive. */
  terminate(): void;
  /** Drop a pending force kill once the tree is known to be gone. */
  cancel(): void;
}

/**
 * Whether a stop can reach descendants at all. It can only when the spawn asked
 * for a process group of its own, which needs POSIX and is only worth the
 * detach on the lease-bound path. Callers pass this same value to `spawn`'s
 * `detached` and to {@link childStop}, so the spawn flag and the stop strategy
 * cannot drift apart.
 */
export function ownsProcessGroup(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && process.platform !== 'win32';
}

export function childStop(
  child: ChildProcess,
  ownsGroup: boolean,
  forceKillDelayMs: number = FORCE_KILL_DELAY_MS,
): ChildStop {
  let forceTimer: NodeJS.Timeout | undefined;
  const cancel = (): void => {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    forceTimer = undefined;
  };
  const signalTree = (name: NodeJS.Signals): void => {
    if (ownsGroup && child.pid !== undefined) {
      // `-pid` addresses the group this detached child leads, which is every
      // descendant that has not left it. It throws only once the whole group
      // is gone — the outcome we were asking for — so fall through and let the
      // direct-child signal report on a child that never became a leader.
      try {
        process.kill(-child.pid, name);
        return;
      } catch { /* the group is gone, or we never led one */ }
    }
    child.kill(name);
  };
  return {
    kill: (): void => {
      cancel();
      signalTree('SIGKILL');
    },
    terminate: (): void => {
      cancel();
      signalTree('SIGTERM');
      forceTimer = setTimeout(() => signalTree('SIGKILL'), forceKillDelayMs);
      // Never a reason on its own to hold the loop open: if no leaked pipe is
      // keeping this process alive, the tree we would force is already gone.
      forceTimer.unref();
    },
    cancel,
  };
}
