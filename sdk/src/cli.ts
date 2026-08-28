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

export type { CheckInputDiagnostic, CheckReport } from './cli/check.js';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

type CliExitCode = 0 | 1 | 2 | 3;
type ParsedArgs =
  | { command: 'check'; json: boolean; value: string }
  | { command: 'run' | 'resume'; dataDir: string; json: boolean; value: string };

const DEFAULT_DATA_DIR = '.relayflowd';
const USAGE = [
  'Usage:',
  'flows check [--json] <flow.yaml|spec.json>',
  'flows run [--json] [--data-dir <dir>] <flow.yaml|spec.json>',
  'flows resume [--json] [--data-dir <dir>] <run-id>',
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

  const execution = parsed.command === 'run'
    ? await runFlow(parsed.value, parsed.dataDir)
    : await resumeFlow(parsed.value, parsed.dataDir);
  emitRunReport(execution, parsed.json, io);
  return execution.exitCode;
}

function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  const command = args[0];
  if (command !== 'check' && command !== 'run' && command !== 'resume') return undefined;

  let json = false;
  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
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
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1) return undefined;

  return command === 'check'
    ? { command, json, value: positionals[0]! }
    : { command, dataDir, json, value: positionals[0]! };
}

function emitCheckReport(report: CheckReport, json: boolean, io: CliIo): void {
  emitDiagnostics(report.diagnostics, io);
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }
  for (const resolution of report.resolutions) {
    const config = resolution.source === 'project' && report.projectConfigPath !== undefined
      ? ` (${report.projectConfigPath})`
      : '';
    io.stdout(`RESOLVED step "${resolution.stepId}" cli "${resolution.cli}" from ${resolution.source}${config}`);
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
