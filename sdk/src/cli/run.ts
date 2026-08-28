import { join, resolve } from 'node:path';
import { toKernelSpec } from '../compile.js';
import type { RunFailureKind } from '../failure-kinds.js';
import { JournalClient } from '../journal-client.js';
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
  const report: RunReport = {
    ...fromBase(command, base),
    ok: outcome.status === 'completed' && outcome.completion_reason === 'success',
    runId: outcome.run_id,
    socketPath,
    status: outcome.status,
    ...(outcome.completion_reason !== null ? { completionReason: outcome.completion_reason } : {}),
    completedSteps: outcome.completed_steps,
  };

  if (report.ok) return { exitCode: 0, report };
  if (outcome.status === 'failed' && outcome.completion_reason !== null) {
    return {
      exitCode: 1,
      report: {
        ...report,
        diagnostics: [...report.diagnostics, {
          severity: 'failure',
          kind: outcome.completion_reason,
          message: `Run "${outcome.run_id}" failed with completionReason: ${outcome.completion_reason}.`,
        }],
      },
    };
  }
  if (outcome.status === 'parked') {
    const parkedStep = await findParkedStep(client, outcome.run_id, knownSpec);
    if (parkedStep !== undefined) {
      return {
        exitCode: 3,
        report: {
          ...report,
          parkedStep,
          diagnostics: [...report.diagnostics, {
            severity: 'parked',
            kind: 'run_parked',
            message: `Run "${outcome.run_id}" parked at step "${parkedStep.id}" (${parkedStep.type}): no worker is attached for step type "${parkedStep.type}".`,
          }],
        },
      };
    }
  }
  return protocolFailure(command, base, socketPath, new Error(
    `relayflowd returned status ${outcome.status} without a classifiable completion`,
  ), outcome.run_id);
}

async function findParkedStep(
  client: JournalClient,
  runId: string,
  knownSpec?: KernelRunSpec,
): Promise<ParkedStep | undefined> {
  const spec = knownSpec ?? await readRunSpec(client, runId);
  if (spec === undefined) return undefined;
  const snapshot = await client.runGet(runId);
  return spec.steps.find((step): step is KernelStepSpec & { type: 'llm' | 'agent' } =>
    step.type !== 'deterministic' && snapshot.steps[step.id] === 'Runnable',
  );
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
