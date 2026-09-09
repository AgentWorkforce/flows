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
 * chooses only the FORCE of the stop, never its REACH — and, per
 * {@link ChildStop.maySettleOnChildExit}, never gets to decide on its own that
 * a stop is finished.
 */
export interface ChildStop {
  /** Stop the tree now, unconditionally. */
  kill(): void;
  /** Ask the tree to stop, then force whatever is still alive. */
  terminate(): void;
  /**
   * Answer the only question a child-level event can raise: the direct child is
   * gone — may the session settle?
   *
   * INVARIANT: a session may not settle until either the process group is
   * confirmed dead or the escalation has actually run.
   *
   * `'close'` and `'error'` are evidence about the CHILD, never about the
   * group. A descendant that ignores `SIGTERM` and inherited none of the
   * wrapper's stdio emits exactly those events while it is still running, so no
   * call site may read one as a dead tree. This is therefore the only place a
   * pending escalation may be dropped for any reason other than a forced kill,
   * and it drops one only after asking the group whether it is empty.
   *
   * Returns true when settling is safe: no escalation is armed, or the group is
   * confirmed gone and the now-pointless escalation has been dropped here.
   * Returns false when an escalation is armed over a group that still answers —
   * the caller must then leave the settle to that escalation's own deadline.
   */
  maySettleOnChildExit(): boolean;
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
  // Pinned at the spawn rather than read per signal. Every interesting use of
  // this id happens AFTER the direct child has been reaped — the escalation
  // fires a second later, and the group probe runs on `'close'` — so reading
  // `child.pid` there would be reading a field the runtime owns and is free to
  // clear. The group keeps this id for as long as any member of it is alive,
  // which is exactly the window both of those need to address.
  const pid = child.pid;
  let forceTimer: NodeJS.Timeout | undefined;
  const cancel = (): void => {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    forceTimer = undefined;
  };
  /** Whether anything is still in the group. See `maySettleOnChildExit`. */
  const groupAnswers = (): boolean => {
    // With no group of our own a stop never reached past the direct child, so
    // that child's exit IS the whole of our reach and there is nothing left to
    // ask about.
    if (!ownsGroup || pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      // Only `ESRCH` proves the group is empty. `EPERM` proves the opposite —
      // something is in there that we may not signal — and any other errno
      // proves nothing at all, so both must read as alive: an unproven group is
      // not a reason to spare a survivor.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const signalTree = (name: NodeJS.Signals): void => {
    if (ownsGroup && pid !== undefined) {
      // `-pid` addresses the group this detached child leads, which is every
      // descendant that has not left it. It throws only once the whole group
      // is gone — the outcome we were asking for — so fall through and let the
      // direct-child signal report on a child that never became a leader.
      try {
        process.kill(-pid, name);
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
      forceTimer = setTimeout(() => {
        forceTimer = undefined;
        signalTree('SIGKILL');
      }, forceKillDelayMs);
      // Deliberately REFERENCED, unlike every other timer we arm. The survivor
      // this escalation exists for is the one that ignored `SIGTERM` and holds
      // none of our stdio: nothing it does keeps our loop alive, so an unref'd
      // escalation would be dropped by the drain in precisely the case it was
      // armed for. The cost is bounded by `forceKillDelayMs`, is paid only
      // after a stop was actually issued, and is refunded the moment
      // `maySettleOnChildExit` confirms the group is empty.
    },
    maySettleOnChildExit: (): boolean => {
      if (forceTimer === undefined) return true;
      if (groupAnswers()) return false;
      cancel();
      return true;
    },
  };
}
