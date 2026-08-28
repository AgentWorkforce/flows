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
import type { KernelRunSpec, KernelStepSpec, StepType } from '../spec.js';
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

export async function runFlow(path: string, dataDir: string): Promise<RunExecution> {
  const checked = checkFlow(path);
  if (!checked.report.ok || checked.flow === undefined) {
    return { exitCode: 2, report: fromCheckReport('run', checked.report) };
  }

  const socketPath = socketFor(dataDir);
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'run', dataDir, checked.report);
  if (connected !== undefined) return connected;

  try {
    const spec = toKernelSpec(checked.flow);
    const outcome = await client.runStart(spec);
    return await classifyOutcome(client, 'run', outcome, checked.report, socketPath, spec);
  } catch (error) {
    return protocolFailure('run', checked.report, socketPath, error);
  } finally {
    client.close();
  }
}

export async function resumeFlow(runId: string, dataDir: string): Promise<RunExecution> {
  const socketPath = socketFor(dataDir);
  const base = emptyReport('resume');
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'resume', dataDir, base);
  if (connected !== undefined) return connected;

  try {
    const outcome = await client.runResume(runId);
    return await classifyOutcome(client, 'resume', outcome, base, socketPath);
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

async function connect(
  client: JournalClient,
  command: RunCommand,
  dataDir: string,
  base: CheckReport | RunReport,
): Promise<RunExecution | undefined> {
  const socketPath = socketFor(dataDir);
  try {
    await client.connect();
    await client.hello(`flows-${command}`);
    return undefined;
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
}

async function classifyOutcome(
  client: JournalClient,
  command: RunCommand,
  outcome: RunOutcome,
  base: CheckReport | RunReport,
  socketPath: string,
  knownSpec?: KernelRunSpec,
): Promise<RunExecution> {
  let current = outcome;
  let parkedStep: ParkedStep | undefined;
  while (current.status === 'parked') {
    const inspection = await inspectOutOfBandStep(client, current.run_id, knownSpec);
    if (inspection?.parkedStep !== undefined) {
      parkedStep = inspection.parkedStep;
      break;
    }
    if (inspection?.runningStepId !== undefined) {
      await waitForRunningStep(client, current.run_id, inspection.runningStepId);
      current = await client.runResume(current.run_id);
      continue;
    }
    if (inspection?.status === 'completed' || inspection?.status === 'failed') {
      current = await client.runResume(current.run_id);
      continue;
    }
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
          message: `Run "${current.run_id}" parked at step "${parkedStep.id}" (${parkedStep.type}): no worker is attached for step type "${parkedStep.type}".`,
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
  runningStepId?: string;
}

async function inspectOutOfBandStep(
  client: JournalClient,
  runId: string,
  knownSpec?: KernelRunSpec,
): Promise<OutOfBandInspection | undefined> {
  const spec = knownSpec ?? await readRunSpec(client, runId);
  if (spec === undefined) return undefined;
  const snapshot = await client.runGet(runId);
  const parkedStep = spec.steps.find((step): step is KernelStepSpec & { type: 'llm' | 'agent' } =>
    step.type !== 'deterministic' && snapshot.steps[step.id] === 'Runnable',
  );
  const runningStep = spec.steps.find((step) =>
    step.type !== 'deterministic' && isRunningStepState(snapshot.steps[step.id]),
  );
  return {
    status: snapshot.status,
    ...(parkedStep !== undefined ? { parkedStep } : {}),
    ...(runningStep !== undefined ? { runningStepId: runningStep.id } : {}),
  };
}

async function waitForRunningStep(
  client: JournalClient,
  runId: string,
  stepId: string,
): Promise<void> {
  while (true) {
    await delay(50);
    const snapshot = await client.runGet(runId);
    if (!isRunningStepState(snapshot.steps[stepId])) return;
  }
}

function isRunningStepState(state: string | undefined): boolean {
  return state === 'Running' || state?.startsWith('Running {') === true;
}

async function readRunSpec(client: JournalClient, runId: string): Promise<KernelRunSpec | undefined> {
  const { entries } = await client.journalRead(runId, 1, 1);
  const entry = entries[0];
  if (!isObject(entry) || entry['entry_type'] !== 'run.spawned') return undefined;
  const payload = entry['payload'];
  if (!isObject(payload) || !isObject(payload['spec'])) return undefined;
  return payload['spec'] as unknown as KernelRunSpec;
}

function protocolFailure(
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

function fromCheckReport(command: RunCommand, report: CheckReport): RunReport {
  return {
    ok: false,
    command,
    ...(report.path !== undefined ? { path: report.path } : {}),
    ...(report.projectConfigPath !== undefined ? { projectConfigPath: report.projectConfigPath } : {}),
    resolutions: report.resolutions,
    diagnostics: report.diagnostics,
  };
}

function emptyReport(command: RunCommand): RunReport {
  return { ok: false, command, resolutions: [], diagnostics: [] };
}

function fromBase(command: RunCommand, base: CheckReport | RunReport): RunReport {
  return 'command' in base ? base : fromCheckReport(command, base);
}

function socketFor(dataDir: string): string {
  return join(resolve(dataDir), 'relayflowd.sock');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown protocol error';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
