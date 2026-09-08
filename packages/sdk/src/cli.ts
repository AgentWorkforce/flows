#!/usr/bin/env node

import { renderProgress, type ProgressEvent } from './progress.js';
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
  type RunProgress,
  type RunReport,
} from './cli/run.js';
import { runDirectFlow } from './cli/direct-run.js';
import { runCloudCli } from './cli/cloud-run.js';
import { isAuthoredFlowPath } from './direct-input.js';
import { runHnMonitor } from './cli/hn-monitor.js';
import { runTickRunner } from './cli/tick-runner.js';

export type { CheckInputDiagnostic, CheckReport } from './cli/check.js';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

type CliExitCode = 0 | 1 | 2 | 3;
type ParsedArgs =
  | { command: 'cloud-run'; value: string; json: boolean; wait: boolean }
  | { command: 'check'; json: boolean; value: string }
  | { command: 'run'; localAgent: boolean; dataDir: string; input: string | undefined; json: boolean; spawn: boolean; value: string }
  | { command: 'resume'; dataDir: string; json: boolean; spawn: boolean; value: string }
  | { command: 'hn-monitor'; sub: 'start'; dataDir: string; specPath: string; pollIntervalMs: number | undefined }
  | { command: 'tick'; sub: 'start'; dataDir: string; specPath: string; scheduleId: string;
      intervalMs: number; epochMs: number | undefined; maxCatchUp: number | undefined;
      pollIntervalMs: number | undefined };

const DEFAULT_DATA_DIR = '.relayflowd';
const USAGE = [
  'Usage:',
  'flows check [--json] <flow.yaml|spec.json>',
  'flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.yaml|spec.json>',
  'flows run --cloud [--json] [--wait] <flow.yaml|spec.json>',
  'flows run [--json] [--no-spawn] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>',
  'flows tick start --schedule-id <id> --interval-ms <ms> [--epoch-ms <ms>] [--max-catch-up <n>] [--poll-interval-ms <ms>] [--data-dir <dir>] <spec.json>',
  'flows resume [--json] [--no-spawn] [--data-dir <dir>] <run-id>',
  'flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>',
].join(' ');

/**
 * `FLOWS_NO_SPAWN=1` is `--no-spawn` for a whole environment: the lever for CI
 * that means to assert a daemon is already present rather than conjure one
 * (kernel/DAEMON-LIFECYCLE.md §4). Only the exact string `1` counts — an
 * unset or empty variable must not be read as an opinion.
 */
function spawnAllowedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FLOWS_NO_SPAWN'] !== '1';
}

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

  if (parsed.command === 'cloud-run') return runCloudCli(parsed, io);

  if (parsed.command === 'check') {
    // Deliberately daemon-free (kernel/DAEMON-LIFECYCLE.md §4). `checkFlow` is
    // a pure compile-and-preflight that opens no socket, and the parser
    // refuses `--data-dir` on `check`, so there is no data dir to attach to.
    // `flows check` keeps working with no daemon, no relayflowd binary and no
    // data directory at all -- a property worth keeping, not an omission.
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

  if (parsed.command === 'tick') {
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      return await runTickRunner({
        dataDir: parsed.dataDir,
        specPath: parsed.specPath,
        schedule: {
          scheduleId: parsed.scheduleId,
          intervalMs: parsed.intervalMs,
          ...(parsed.epochMs === undefined ? {} : { epochMs: parsed.epochMs }),
          ...(parsed.maxCatchUp === undefined ? {} : { maxCatchUp: parsed.maxCatchUp }),
        },
        pollIntervalMs: parsed.pollIntervalMs,
        signal: controller.signal,
      }, io) as CliExitCode;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }

  // Attach-or-spawn runs inside `runFlow`/`resumeFlow`/`runDirectFlow`, at the
  // single `connect()` seam immediately before journal-client.ts is used --
  // not here. Hoisting it above the dispatch would start a daemon as a side
  // effect of an invocation that is about to be refused for bad input.
  const startedSteps = new Map<string, number>();
  const showProgress = (event: ProgressEvent): void => {
    if (event.type === 'step.started') startedSteps.set(event.stepId, performance.now());
    if (!parsed.json) for (const line of renderProgress([event])) io.stderr(line);
  };
  const lifecycle = {
    localAgent: parsed.command === 'run' && parsed.localAgent,
    onProgress: showProgress,
    onWait: (progress: RunProgress) => {
      emitWait(progress, io);
      showProgress({ type: 'step.running', stepId: progress.stepId, stepType: progress.stepType,
        elapsedMs: performance.now() - (startedSteps.get(progress.stepId) ?? performance.now()) });
    },
    daemon: { spawn: parsed.spawn && spawnAllowedByEnv() },
  };
  const execution = parsed.command === 'run'
    ? isAuthoredFlowPath(parsed.value)
      ? await runDirectFlow(parsed.value, parsed.input, parsed.dataDir, lifecycle)
      : await runFlow(parsed.value, parsed.dataDir, lifecycle)
    : await resumeFlow(parsed.value, parsed.dataDir, lifecycle);
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
  if (command === 'tick') return parseTickArgs(args.slice(1));
  if (command !== 'check' && command !== 'run' && command !== 'resume') return undefined;

  let json = false;
  let cloud = false;
  let wait = false;
  let localAgent = false;
  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let spawn = true;
  let input: string | undefined;
  let sawInput = false;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--cloud' || argument === '--wait') {
      if (command !== 'run' || (argument === '--cloud' ? cloud : wait)) return undefined;
      if (argument === '--cloud') cloud = true;
      else wait = true;
      continue;
    }
    if (argument === '--local-agent') {
      if (command !== 'run' || localAgent) return undefined;
      localAgent = true;
      continue;
    }
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument === '--no-spawn') {
      // Refused on `check` for the same reason `--data-dir` is: `check` never
      // opens a socket, so a daemon flag there would describe nothing.
      if (command === 'check' || !spawn) return undefined;
      spawn = false;
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

  if (cloud) {
    // `--cloud` submits the spec to Cloud, so every flag that only describes a
    // local run -- an inline input, a data dir, a suppressed daemon, a local
    // agent -- describes nothing there and is refused rather than ignored.
    if (sawInput || sawDataDir || !spawn || localAgent) return undefined;
    return { command: 'cloud-run', value: positionals[0]!, json, wait };
  }
  if (wait) return undefined;

  if (localAgent && !isAuthoredFlowPath(positionals[0]!)) return undefined;
  if (command === 'run' && input !== undefined && !isAuthoredFlowPath(positionals[0]!)) return undefined;
  return command === 'check'
    ? { command, json, value: positionals[0]! }
    : command === 'run'
      ? { command, localAgent, dataDir, input, json, spawn, value: positionals[0]! }
      : { command, dataDir, json, spawn, value: positionals[0]! };
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

/**
 * `flows tick start`. Numeric flags are parsed here but their BOUNDS are not
 * re-derived: `runTickRunner` calls `assertTickScheduleValid`, the same
 * function `emitDueTicks` uses, so the CLI's refusal and the emit path's
 * refusal cannot drift. This parser only rejects shapes it cannot turn into a
 * number at all.
 */
function parseTickArgs(rest: readonly string[]): ParsedArgs | undefined {
  const sub = rest[0];
  if (sub !== 'start') return undefined;

  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let scheduleId: string | undefined;
  let intervalMs: number | undefined;
  let epochMs: number | undefined;
  let maxCatchUp: number | undefined;
  let pollIntervalMs: number | undefined;
  const positionals: string[] = [];

  // Number, not parseInt: parseInt('1.5') is 1, so a fractional --interval-ms
  // would silently become a 1ms schedule instead of being refused. Requiring
  // an exact integer round-trip rejects '1.5', '1e3', '0x10' and ' 1' rather
  // than coercing them into something the operator did not write.
  const takeNumber = (value: string | undefined): number | undefined => {
    if (value === undefined || value.startsWith('-')) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || String(parsed) !== value) return undefined;
    return parsed;
  };

  for (let index = 1; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--data-dir') {
      const value = rest[index + 1];
      if (sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value; sawDataDir = true; index += 1; continue;
    }
    if (argument === '--schedule-id') {
      const value = rest[index + 1];
      if (scheduleId !== undefined || value === undefined || value.startsWith('-')) return undefined;
      scheduleId = value; index += 1; continue;
    }
    if (argument === '--interval-ms') {
      if (intervalMs !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      intervalMs = value; index += 1; continue;
    }
    if (argument === '--epoch-ms') {
      if (epochMs !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      epochMs = value; index += 1; continue;
    }
    if (argument === '--max-catch-up') {
      if (maxCatchUp !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      maxCatchUp = value; index += 1; continue;
    }
    if (argument === '--poll-interval-ms') {
      if (pollIntervalMs !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      pollIntervalMs = value; index += 1; continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1 || scheduleId === undefined || intervalMs === undefined) return undefined;
  return {
    command: 'tick', sub: 'start', dataDir, specPath: positionals[0]!,
    scheduleId, intervalMs, epochMs, maxCatchUp, pollIntervalMs,
  };
}

function emitCheckReport(report: CheckReport, json: boolean, io: CliIo): void {
  emitDiagnostics(report.diagnostics, io);
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }
  for (const gate of report.gates) {
    // A gate that accepts every output is legal, but it must not read like a
    // gate that judges something.
    const vacuous = gate.acceptsAnyOutput === true ? ' [json_schema accepts any output]' : '';
    io.stdout(`GATE step "${gate.stepId}" ${gate.checks.join('+')} from data (kernel, journal-replayable)${vacuous}`);
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
