// Turning a non-attached `DaemonState` into a `flows run` / `flows resume`
// diagnostic (kernel/DAEMON-LIFECYCLE.md §4).
//
// Its own file because run.ts is already at the size AGENTS.md rule 1 calls a
// design smell, and because the mapping is a pure function of the state: no
// I/O, no process, nothing to stub to test it.

import { type DaemonState } from '../daemon-lifecycle.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import type { RunDiagnostic } from './run.js';

/**
 * Map a non-attached `DaemonState` onto the closed run taxonomy. Each of these
 * is exit 2 — refused before a journal write — which is what docs/SURFACE.md
 * §5 already promises for an unreachable daemon; only the `kind` and the
 * message are new.
 */
export function daemonRefusal(
  daemon: Exclude<DaemonState, { kind: 'attached' }>,
  dataDir: string,
  socketPath: string,
): RunDiagnostic {
  if (daemon.kind === 'incompatible') {
    return {
      severity: 'refusal',
      kind: 'daemon_protocol_mismatch',
      message: `relayflowd at "${socketPath}" speaks journal protocol ${daemon.protocol}, not ${PROTOCOL_VERSION}. `
        + 'Refusing rather than starting a second daemon over a live incompatible one.',
    };
  }
  if (daemon.kind !== 'unavailable') {
    // `absent` and `stale` are decisions to spawn, never terminal answers from
    // `ensureDaemon`; reaching here would mean the algorithm returned mid-flight.
    return {
      severity: 'refusal',
      kind: 'daemon_unreachable',
      message: `No compatible relayflowd is listening at "${socketPath}". Start it with: relayflowd --data-dir ${JSON.stringify(dataDir)} serve`,
    };
  }
  if (daemon.failure === 'daemon_unreachable') {
    // `--no-spawn` / FLOWS_NO_SPAWN=1: byte-for-byte today's refusal.
    return {
      severity: 'refusal',
      kind: 'daemon_unreachable',
      message: `No compatible relayflowd is listening at "${socketPath}". Start it with: relayflowd --data-dir ${JSON.stringify(dataDir)} serve`,
    };
  }
  return { severity: 'refusal', kind: daemon.failure, message: daemon.message };
}
