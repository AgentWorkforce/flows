import { probeSocket } from '../daemon-connection.js';
import { AuthoredFlowExecutionError } from '../authored-flow-error.js';
import { resumeCommand } from '../authored-human.js';
import { isReadInterruptionError, JournalReadInterruptedError } from '../journal-read-policy.js';
import type { CheckReport } from './check.js';
import type { RunExecution, RunReport, RunLifecycleOptions, RunCommand } from './run.js';

export function isReadInterruption(error: unknown): boolean {
  return isReadInterruptionError(error)
    || (error instanceof AuthoredFlowExecutionError && error.code === 'daemon_unresponsive');
}

/**
 * A completed run whose stored result could not be read back. The run is
 * finished — nothing to resume — but its authored verdict is unknown, so the
 * report claims neither success nor a reason, and says how to read it later.
 */
export function completedResultUnreadableReport(command: RunCommand, base: CheckReport | RunReport,
  socketPath: string, error: AuthoredFlowExecutionError): RunExecution {
  const runId = error.rootRunId ?? error.runId;
  return { exitCode: 1, report: {
    ...base, command, ok: false, socketPath, status: 'completed',
    ...(runId === undefined ? {} : { runId, rootRunId: runId }),
    diagnostics: [...base.diagnostics, { severity: 'warning', kind: 'result_unreadable',
      message: `${error.message}. The run is finished; its verdict is unconfirmed`
        + (runId === undefined ? '.' : ` — read it with \`flows status ${runId}\` once relayflowd answers.`) }],
  } as RunExecution['report'] };
}

export async function daemonUnresponsiveReport(command: RunCommand,
  base: CheckReport | RunReport, socketPath: string, error: unknown, fallbackRunId?: string,
  options: RunLifecycleOptions = {}, dataDir?: string): Promise<RunExecution> {
  const runId = error instanceof AuthoredFlowExecutionError ? error.rootRunId ?? fallbackRunId : fallbackRunId;
  const reachable = (await probeSocket(socketPath)).reachable;
  const kind = reachable ? 'daemon_unresponsive' : 'daemon_unreachable';
  const detail = error instanceof JournalReadInterruptedError
    ? (reachable ? 'relayflowd answers a fresh connection but the run read session kept being interrupted.'
      : 'relayflowd did not answer a fresh connection after the run read session was interrupted; it may be unreachable or delayed by CPU load.')
    : reachable ? 'relayflowd answers a fresh connection but the run read timed out; CPU load may be delaying it.'
    : 'relayflowd did not answer a fresh connection; it may be unreachable or delayed by CPU load.';
  return { exitCode: 1, report: {
    ...base, command, ok: false, socketPath, status: 'running',
    ...(runId === undefined ? {} : { runId, rootRunId: runId }),
    diagnostics: [...base.diagnostics, { severity: 'failure', kind,
      message: `${detail} ${error instanceof Error ? error.message : String(error)}`
        + (runId === undefined ? '' : ` The run remains resumable. Continue with: ${resumeCommand(runId, dataDir ?? options.dataDir, options.localAgent === true)}.`),
    }],
  } };
}
