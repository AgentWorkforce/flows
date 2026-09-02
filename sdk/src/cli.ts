#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  checkFlow,
  inputFailureReport,
  type CheckReport,
} from './cli/check.js';
import {
  resumeFlow,
  runFlow,
  type RunExecution,
  type RunReport,
} from './cli/run.js';
import { runDirectFlow } from './cli/direct-run.js';
import { isAuthoredFlowPath } from './direct-input.js';
import { runHnMonitor } from './cli/hn-monitor.js';

export type { CheckInputDiagnostic, CheckReport } from './cli/check.js';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

type CliExitCode = 0 | 1 | 2 | 3;
type ParsedArgs =
  | { command: 'check'; json: boolean; value: string }
  | { command: 'run'; dataDir: string; input: string | undefined; json: boolean; value: string }
  | { command: 'resume'; dataDir: string; json: boolean; value: string }
  | { command: 'hn-monitor'; sub: 'start'; dataDir: string; specPath: string; pollIntervalMs: number | undefined };

const DEFAULT_DATA_DIR = '.relayflowd';
const USAGE = [
  'Usage:',
  'flows check [--json] <flow.yaml|spec.json>',
  'flows run [--json] [--data-dir <dir>] <flow.yaml|spec.json>',
  'flows run [--json] [--data-dir <dir>] <flow.ts> --input <inline-json-or-file>',
  'flows resume [--json] [--data-dir <dir>] <run-id>',
  'flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>',
].join(' ');

const PROCESS_IO: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

export async function runCli(
  args: readonly string[],
  io: CliIo = PROCESS_IO,
): Promise<CliExitCode> {
  const parsed = parseArgs(args);
  if (parsed === undefined) {
    const report = inputFailureReport({ kind: 'invalid_invocation', message: USAGE });
    emitCheckReport(report, args.includes('--json'), io);
    return 2;
  }

  if (parsed.command === 'check') {
    const checked = checkFlow(parsed.value);
    emitCheckReport(checked.report, parsed.json, io);
    return checked.report.ok ? 0 : 2;
  }

  if (parsed.command === 'hn-monitor') {
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      return await runHnMonitor({
        dataDir: parsed.dataDir,
        specPath: parsed.specPath,
        pollIntervalMs: parsed.pollIntervalMs,
        signal: controller.signal,
      }, io);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }

  const execution = parsed.command === 'run'
    ? isAuthoredFlowPath(parsed.value)
      ? await runDirectFlow(
          parsed.value,
          parsed.input,
          parsed.dataDir,
          { onWait: (progress) => emitWait(progress, io) },
        )
      : await runFlow(parsed.value, parsed.dataDir, { onWait: (progress) => emitWait(progress, io) })
    : await resumeFlow(parsed.value, parsed.dataDir, { onWait: (progress) => emitWait(progress, io) });
  emitRunReport(execution, parsed.json, io);
  return execution.exitCode;
}

function emitWait(
  progress: { runId: string; stepId: string; stepType: string; leaseDeadlineMs: number },
  io: CliIo,
): void {
  io.stderr(
    `WAITING [worker_lease] Run "${progress.runId}" step "${progress.stepId}" (${progress.stepType}) `
      + `is running under a worker lease until ${progress.leaseDeadlineMs}.`,
  );
}

function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  const command = args[0];
  if (command === 'hn-monitor') return parseHnMonitorArgs(args.slice(1));
  if (command !== 'check' && command !== 'run' && command !== 'resume') return undefined;

  let json = false;
  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let input: string | undefined;
  let sawInput = false;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument === '--data-dir') {
      const value = args[index + 1];
      if (command === 'check' || sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value;
      sawDataDir = true;
      index += 1;
      continue;
    }
    if (argument === '--input') {
      const value = args[index + 1];
      if (command !== 'run' || sawInput || value === undefined || value.startsWith('--')) return undefined;
      input = value;
      sawInput = true;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1) return undefined;

  if (command === 'run' && input !== undefined && !isAuthoredFlowPath(positionals[0]!)) return undefined;
  return command === 'check'
    ? { command, json, value: positionals[0]! }
    : command === 'run'
      ? { command, dataDir, input, json, value: positionals[0]! }
      : { command, dataDir, json, value: positionals[0]! };
}

function parseHnMonitorArgs(rest: readonly string[]): ParsedArgs | undefined {
  const sub = rest[0];
  if (sub !== 'start') return undefined;

  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let pollIntervalMs: number | undefined;
  const positionals: string[] = [];
  for (let index = 1; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--data-dir') {
      const value = rest[index + 1];
      if (sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value;
      sawDataDir = true;
      index += 1;
      continue;
    }
    if (argument === '--poll-interval-ms') {
      const value = rest[index + 1];
      if (pollIntervalMs !== undefined || value === undefined || value.startsWith('-')) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
      pollIntervalMs = parsed;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1) return undefined;
  return { command: 'hn-monitor', sub: 'start', dataDir, specPath: positionals[0]!, pollIntervalMs };
}

function emitCheckReport(report: CheckReport, json: boolean, io: CliIo): void {
  emitDiagnostics(report.diagnostics, io);
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }
  for (const gate of report.gates) {
    io.stdout(`GATE step "${gate.stepId}" ${gate.checks.join('+')} from data (kernel, journal-replayable)`);
  }
  for (const resolution of report.resolutions) {
    const config = resolution.source === 'project' && report.projectConfigPath !== undefined
      ? ` (${report.projectConfigPath})`
      : '';
    const model = resolution.model === undefined ? '' : ` model "${resolution.model}"`;
    io.stdout(`RESOLVED step "${resolution.stepId}" cli "${resolution.cli}"${model} from ${resolution.source}${config}`);
  }
  if (report.ok) io.stdout(`CHECK PASSED ${report.path ?? ''}`.trimEnd());
}

function emitRunReport(execution: RunExecution, json: boolean, io: CliIo): void {
  const { report } = execution;
  emitDiagnostics(report.diagnostics, io);
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }
  if (report.runId === undefined) return;
  const completed = report.completedSteps === undefined ? '' : ` (${report.completedSteps} steps)`;
  const reason = report.completionReason === undefined
    ? ''
    : ` completionReason: ${report.completionReason}`;
  io.stdout(`RUN ${report.runId} ${report.status ?? 'unknown'}${completed}${reason}`);
}

function emitDiagnostics(
  diagnostics: CheckReport['diagnostics'] | RunReport['diagnostics'],
  io: CliIo,
): void {
  for (const diagnostic of diagnostics) {
    io.stderr(`${diagnosticLabel(diagnostic.severity)} [${diagnostic.kind}] ${diagnostic.message}`);
  }
}

function diagnosticLabel(severity: string): string {
  switch (severity) {
    case 'warning': return 'WARNING';
    case 'failure': return 'FAILED';
    case 'parked': return 'PARKED';
    default: return 'REFUSED';
  }
}

function isDirectInvocation(entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
