import { join, resolve } from 'node:path';
import { toKernelSpec } from '../compile.js';
import type { RunFailureKind } from '../failure-kinds.js';
import { JournalClient, JournalProtocolError } from '../journal-client.js';
import type { PreflightDiagnostic } from '../preflight.js';
import type {
  RunCompletionReason,
  RunOutcome,
  RunStatus,
} from '../protocol.js';
import type { StepType } from '../spec.js';
import {
  checkFlow,
  type CheckInputDiagnostic,
  type CheckReport,
} from './check.js';

export type RunExitCode = 0 | 1 | 2 | 3;
export type RunCommand = 'run' | 'resume';

export interface ParkedStep {
  id: string;
  type: Extract<StepType, 'llm' | 'agent'>;
}

export interface RunDiagnostic {
  severity: 'refusal' | 'failure' | 'parked';
  kind: RunFailureKind | RunCompletionReason;
  message: string;
}

export interface RunReport {
  ok: boolean;
  command: RunCommand;
  path?: string;
  runId?: string;
  socketPath?: string;
  status?: RunStatus;
  completionReason?: RunCompletionReason;
  completedSteps?: number;
  parkedStep?: ParkedStep;
  projectConfigPath?: string;
  resolutions: CheckReport['resolutions'];
  diagnostics: Array<PreflightDiagnostic | CheckInputDiagnostic | RunDiagnostic>;
}

export interface RunExecution {
  exitCode: RunExitCode;
  report: RunReport;
}

export interface RunProgress {
  runId: string;
  stepId: string;
  stepType: Extract<StepType, 'llm' | 'agent'>;
  leaseDeadlineMs: number;
}

export interface RunLifecycleOptions {
  signal?: AbortSignal;
  onWait?: (progress: RunProgress) => void;
}

export async function runFlow(
  path: string,
  dataDir: string,
  options: RunLifecycleOptions = {},
): Promise<RunExecution> {
  const checked = checkFlow(path);
  if (!checked.report.ok || checked.flow === undefined) {
    return { exitCode: 2, report: fromCheckReport('run', checked.report) };
  }

  return executeCheckedFlow(checked, dataDir, options);
}

async function executeCheckedFlow(
  checked: ReturnType<typeof checkFlow>,
  dataDir: string,
  options: RunLifecycleOptions,
): Promise<RunExecution> {
  const socketPath = socketFor(dataDir);
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'run', dataDir, checked.report);
  if (connected !== undefined) return connected;

  try {
    const spec = toKernelSpec(checked.flow!);
    const outcome = await client.runStart(spec);
    return await classifyOutcome(client, 'run', outcome, checked.report, socketPath, options);
  } catch (error) {
    return protocolFailure('run', checked.report, socketPath, error);
  } finally {
    client.close();
  }
}

export async function resumeFlow(
  runId: string,
  dataDir: string,
  options: RunLifecycleOptions = {},
): Promise<RunExecution> {
  const socketPath = socketFor(dataDir);
  const base = emptyReport('resume');
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'resume', dataDir, base);
  if (connected !== undefined) return connected;

  try {
    const outcome = await client.runResume(runId);
    return await classifyOutcome(client, 'resume', outcome, base, socketPath, options);
  } catch (error) {
    if (!(error instanceof JournalProtocolError) || error.code !== 'run_not_found') {
      return protocolFailure('resume', base, socketPath, error, runId);
    }
    return {
      exitCode: 2,
      report: {
        ...base,
        runId,
        socketPath,
        diagnostics: [{
          severity: 'refusal',
          kind: 'run_unavailable',
          message: `Run "${runId}" could not be resumed by relayflowd at "${socketPath}": ${errorMessage(error)}`,
        }],
      },
    };
  } finally {
    client.close();
  }
}

export async function connect(
  client: JournalClient,
  command: RunCommand,
  dataDir: string,
  base: CheckReport | RunReport,
): Promise<RunExecution | undefined> {
  const socketPath = socketFor(dataDir);
  try {
    await client.connect();
  } catch {
    client.close();
    return {
      exitCode: 2,
      report: {
        ...fromBase(command, base),
        socketPath,
        diagnostics: [
          ...base.diagnostics,
          {
            severity: 'refusal',
            kind: 'daemon_unreachable',
            message: `No compatible relayflowd is listening at "${socketPath}". Start it with: relayflowd --data-dir ${JSON.stringify(dataDir)} serve`,
          },
        ],
      },
    };
  }
  try {
    await client.hello(`flows-${command}`);
    return undefined;
  } catch (error) {
    client.close();
    return protocolFailure(command, base, socketPath, error);
  }
}

async function classifyOutcome(
  client: JournalClient,
  command: RunCommand,
  outcome: RunOutcome,
  base: CheckReport | RunReport,
  socketPath: string,
  options: RunLifecycleOptions,
): Promise<RunExecution> {
  let current = outcome;
  let parkedStep: ParkedStep | undefined;
  let needsHuman = false;
  let unclassifiedPolls = 0;
  while (current.status === 'parked') {
    const inspection = await inspectOutOfBandStep(client, current.run_id);
    if (inspection?.parkedStep !== undefined) {
      parkedStep = inspection.parkedStep;
      needsHuman = inspection.needsHuman;
      break;
    }
    if (inspection?.runningStep !== undefined) {
      await waitForRunningStep(client, current.run_id, inspection.runningStep, options);
      current = await client.runResume(current.run_id);
      continue;
    }
    if (inspection?.status === 'completed' || inspection?.status === 'failed') {
      current = await client.runResume(current.run_id);
      continue;
    }
    // The run is still RUNNING but no step is identifiable at this instant.
    //
    // That is a healthy state, not a protocol error. It happens when a worker
    // has just completed the step this run parked on and the daemon has not yet
    // finished driving what follows: nothing is `needs_human`, `runnable` or
    // `running` for a moment, while the snapshot's own status is `running`.
    // Breaking here left `status === 'parked'` with no `parkedStep`, so the
    // tail reported `parked without a classifiable completion` -- a spurious
    // failure on a run that was about to succeed (#179). Reproduced 1 in 4-15
    // locally; the probe that caught it printed
    // `inspection={"status":"running","needsHuman":false}`.
    //
    // So poll it, bounded. Resuming immediately would spin, since the daemon
    // needs a moment to advance.
    if (inspection?.status === 'running' && unclassifiedPolls < MAX_UNCLASSIFIED_POLLS) {
      unclassifiedPolls += 1;
      await new Promise((resolve) => setTimeout(resolve, UNCLASSIFIED_POLL_MS));
      current = await client.runResume(current.run_id);
      continue;
    }
    // Fail closed rather than loop forever: if it never resolves, the original
    // error below still fires and says so.
    break;
  }

  const report: RunReport = {
    ...fromBase(command, base),
    ok: current.status === 'completed' && current.completion_reason === 'success',
    runId: current.run_id,
    socketPath,
    status: current.status,
    ...(current.completion_reason !== null ? { completionReason: current.completion_reason } : {}),
    completedSteps: current.completed_steps,
  };

  if (report.ok) return { exitCode: 0, report };
  if (current.status === 'failed' && current.completion_reason !== null) {
    return {
      exitCode: 1,
      report: {
        ...report,
        diagnostics: [...report.diagnostics, {
          severity: 'failure',
          kind: current.completion_reason,
          message: `Run "${current.run_id}" failed with completionReason: ${current.completion_reason}.`,
        }],
      },
    };
  }
  if (current.status === 'parked' && parkedStep !== undefined) {
    return {
      exitCode: 3,
      report: {
        ...report,
        parkedStep,
        diagnostics: [...report.diagnostics, {
          severity: 'parked',
          kind: 'run_parked',
          message: needsHuman
            ? `Run "${current.run_id}" parked at step "${parkedStep.id}" (${parkedStep.type}): waiting for human recovery after the worker attempt failed.`
            : `Run "${current.run_id}" parked at step "${parkedStep.id}" (${parkedStep.type}): no worker is attached for step type "${parkedStep.type}".`,
        }],
      },
    };
  }
  return protocolFailure(command, base, socketPath, new Error(
    `relayflowd returned status ${current.status} without a classifiable completion`,
  ), current.run_id);
}

interface OutOfBandInspection {
  status: RunStatus;
  parkedStep?: ParkedStep;
  needsHuman: boolean;
  runningStep?: RunningStep;
}

interface RunningStep extends ParkedStep {
  leaseDeadlineMs: number;
}

/// Bound on re-polling a run that reports `running` with no identifiable step.
/// 40 x 50ms = 2s, far longer than the sub-second window observed in #179, and
/// short enough that a genuinely stuck run still reports rather than hangs.
const MAX_UNCLASSIFIED_POLLS = 40;
const UNCLASSIFIED_POLL_MS = 50;

async function inspectOutOfBandStep(
  client: JournalClient,
  runId: string,
): Promise<OutOfBandInspection | undefined> {
  const snapshot = await client.runGet(runId);
  const entries = Object.entries(snapshot.steps);
  const humanEntry = entries.find(([, step]) =>
    step.type !== 'deterministic' && step.state === 'needs_human',
  );
  const runnableEntry = entries.find(([, step]) =>
    step.type !== 'deterministic' && step.state === 'runnable',
  );
  const runningEntry = entries.find(([, step]) =>
    step.type !== 'deterministic' && step.state === 'running',
  );
  const parkedEntry = humanEntry ?? runnableEntry;
  const parkedStep = parkedEntry === undefined ? undefined : {
    id: parkedEntry[0],
    type: parkedEntry[1].type as Extract<StepType, 'llm' | 'agent'>,
  };
  const runningStep = runningEntry === undefined ? undefined : {
    id: runningEntry[0],
    type: runningEntry[1].type as Extract<StepType, 'llm' | 'agent'>,
    leaseDeadlineMs: runningEntry[1].lease_deadline_ms ?? Number.NaN,
  };
  return {
    status: snapshot.status,
    needsHuman: humanEntry !== undefined,
    ...(parkedStep !== undefined ? { parkedStep } : {}),
    ...(runningStep !== undefined ? { runningStep } : {}),
  };
}

async function waitForRunningStep(
  client: JournalClient,
  runId: string,
  runningStep: RunningStep,
  options: RunLifecycleOptions,
): Promise<void> {
  let leaseDeadlineMs = runningStep.leaseDeadlineMs;
  if (!Number.isFinite(leaseDeadlineMs)) {
    throw new Error(`running step "${runningStep.id}" omitted lease_deadline_ms`);
  }
  options.onWait?.({
    runId,
    stepId: runningStep.id,
    stepType: runningStep.type,
    leaseDeadlineMs,
  });
  while (true) {
    throwIfCanceled(options.signal, runningStep.id);
    const remainingMs = leaseDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `worker lease for step "${runningStep.id}" expired at ${leaseDeadlineMs} without completion`,
      );
    }
    await delay(Math.min(50, remainingMs), options.signal);
    const snapshot = await client.runGet(runId);
    const step = snapshot.steps[runningStep.id];
    if (step?.state !== 'running') return;
    if (step.lease_deadline_ms !== undefined && step.lease_deadline_ms !== leaseDeadlineMs) {
      leaseDeadlineMs = step.lease_deadline_ms;
      options.onWait?.({
        runId,
        stepId: runningStep.id,
        stepType: runningStep.type,
        leaseDeadlineMs,
      });
    }
  }
}

export function protocolFailure(
  command: RunCommand,
  base: CheckReport | RunReport,
  socketPath: string,
  error: unknown,
  runId?: string,
): RunExecution {
  return {
    exitCode: 1,
    report: {
      ...fromBase(command, base),
      ...(runId !== undefined ? { runId } : {}),
      socketPath,
      diagnostics: [...base.diagnostics, {
        severity: 'failure',
        kind: 'protocol_error',
        message: `relayflowd could not complete the ${command} request: ${errorMessage(error)}`,
      }],
    },
  };
}

export function fromCheckReport(command: RunCommand, report: CheckReport): RunReport {
  return {
    ok: false,
    command,
    ...(report.path !== undefined ? { path: report.path } : {}),
    ...(report.projectConfigPath !== undefined ? { projectConfigPath: report.projectConfigPath } : {}),
    resolutions: report.resolutions,
    diagnostics: report.diagnostics,
  };
}

export function emptyReport(command: RunCommand): RunReport {
  return { ok: false, command, resolutions: [], diagnostics: [] };
}

function fromBase(command: RunCommand, base: CheckReport | RunReport): RunReport {
  return 'command' in base ? base : fromCheckReport(command, base);
}

export function socketFor(dataDir: string): string {
  return join(resolve(dataDir), 'relayflowd.sock');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown protocol error';
}

function throwIfCanceled(signal: AbortSignal | undefined, stepId: string): void {
  if (signal?.aborted === true) throw new Error(`waiting for running step "${stepId}" was canceled`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', cancel);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    if (signal === undefined) return;
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      rejectDelay(new Error('worker wait canceled'));
    };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}
