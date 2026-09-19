import type { ChildStop } from './child-stop.js';

/**
 * An agent CLI runs in a process group of its own, so nothing that ends this
 * process reaches it by default: a signal to our pid, or to our group, leaves
 * it running, reparented to init. That is how a `claude` outlived a Cloud run
 * that was killed at its deadline, for hours. While any agent is live this
 * module kills every live agent tree on the way out:
 *
 * - on `'exit'`, which covers normal exit and `process.exit()`;
 * - on SIGINT, SIGTERM and SIGHUP, but only where the default action would
 *   have ended the process anyway — this listener is the only one. It then
 *   removes itself and re-raises the signal, so the process still dies of it.
 *   A host that installed its own listener owns that signal; it aborts the
 *   lease signal, and the abort already stops the tree.
 *
 * Nothing survives a SIGKILL of this process; that needs a supervisor.
 */
const live = new Set<ChildStop>();
const FATAL_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function killAll(): void {
  for (const stop of live) stop.kill();
  live.clear();
}

function onFatalSignal(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) !== 1) return;
  killAll();
  uninstall();
  process.kill(process.pid, signal);
}

function install(): void {
  process.on('exit', killAll);
  for (const signal of FATAL_SIGNALS) process.on(signal, onFatalSignal);
}

function uninstall(): void {
  process.off('exit', killAll);
  for (const signal of FATAL_SIGNALS) process.off(signal, onFatalSignal);
}

/** Kill this agent tree if the process ends first. Returns the release. */
export function reapOnExit(stop: ChildStop): () => void {
  if (live.size === 0) install();
  live.add(stop);
  return () => {
    if (!live.delete(stop)) return;
    if (live.size === 0) uninstall();
  };
}
