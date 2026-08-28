#!/usr/bin/env node

import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { CompileError, compileSpec, kernelToAuthoring } from './compile.js';
import type { FlowSpec } from './spec.js';
import type { CheckFailureKind } from './failure-kinds.js';
import {
  preflight,
  CliProbeError,
  type CliResolution,
  type PreflightDiagnostic,
  type PreflightProbes,
} from './preflight.js';

interface ProjectConfig {
  cli?: string;
  executors: string[];
  directory: string;
  path?: string;
}

export interface CheckReport {
  ok: boolean;
  path?: string;
  projectConfigPath?: string;
  resolutions: CliResolution[];
  diagnostics: Array<PreflightDiagnostic | CheckInputDiagnostic>;
}

export interface CheckInputDiagnostic {
  severity: 'refusal';
  kind: CheckFailureKind;
  message: string;
}

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const PROCESS_IO: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

class CheckFailure extends Error {
  constructor(readonly kind: CheckFailureKind, message: string) {
    super(message);
  }
}

export function runCli(args: readonly string[], io: CliIo = PROCESS_IO): number {
  const parsed = parseArgs(args);
  // No path is known yet, and `--json` is honoured even when the invocation
  // itself is what failed — a caller parsing stdout gets a report either way.
  if (parsed instanceof CheckFailure) {
    return emitInputFailure(parsed, undefined, args.includes('--json'), io);
  }

  const absolutePath = resolve(parsed.path);
  try {
    const flow = readFlow(absolutePath);
    const config = readProjectConfig(dirname(absolutePath));
    const probes = systemProbes(dirname(absolutePath), config);
    const result = preflight(flow, {
      projectCli: config.cli,
      projectConfigPath: config.path,
      projectSearchStart: dirname(absolutePath),
      probes,
    });
    const report: CheckReport = {
      ok: result.ok,
      path: parsed.path,
      ...(config.path !== undefined ? { projectConfigPath: config.path } : {}),
      resolutions: result.resolutions,
      diagnostics: result.diagnostics,
    };
    emitReport(report, parsed.json, io);
    return result.ok ? 0 : 2;
  } catch (error) {
    const failure = error instanceof CheckFailure
      ? error
      : new CheckFailure('invalid_spec', `Flow "${parsed.path}" could not be checked as a Relayflow spec.`);
    return emitInputFailure(failure, parsed.path, parsed.json, io);
  }
}

function parseArgs(args: readonly string[]): { path: string; json: boolean } | CheckFailure {
  if (args[0] !== 'check') {
    return new CheckFailure('invalid_invocation', 'Usage: flows check [--json] <flow.yaml|spec.json>');
  }
  const json = args.includes('--json');
  const unsupported = args.slice(1).filter((arg) => arg.startsWith('-') && arg !== '--json');
  const positionals = args.slice(1).filter((arg) => arg !== '--json');
  if (unsupported.length > 0 || positionals.length !== 1) {
    return new CheckFailure('invalid_invocation', 'Usage: flows check [--json] <flow.yaml|spec.json>');
  }
  return { path: positionals[0]!, json };
}

function readFlow(path: string): FlowSpec {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new CheckFailure('input_unreadable', `Flow "${path}" is not readable.`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    throw new CheckFailure('invalid_spec', `Flow "${path}" contains invalid YAML or JSON.`);
  }

  try {
    const marker = kernelDialectMarker(parsed);
    const authoring = marker === undefined ? parsed : kernelToAuthoring(parsed);
    return compileSpec(authoring);
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    if (error instanceof CompileError) {
      const marker = kernelDialectMarker(parsed);
      const dialect = marker === undefined
        ? ''
        : `Flow "${path}" was read as a compiled kernel spec because ${marker} is present. `;
      throw new CheckFailure('invalid_spec', `${dialect}${error.errors.join('; ')}`);
    }
    throw new CheckFailure('invalid_spec', `Flow "${path}" is not a valid Relayflow spec.`);
  }
}

function readProjectConfig(start: string): ProjectConfig {
  const configPath = findConfig(start);
  if (configPath === undefined) return { executors: [], directory: start };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" is not valid JSON.`);
  }
  if (!isObject(value) || Object.keys(value).some((key) => !['cli', 'executors'].includes(key))) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" expects only cli and executors.`);
  }
  if (value['cli'] !== undefined && !isNonEmptyString(value['cli'])) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" has an invalid cli.`);
  }
  if (value['executors'] !== undefined && (!Array.isArray(value['executors']) || !value['executors'].every(isNonEmptyString))) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" has invalid executors.`);
  }
  return {
    ...(value['cli'] !== undefined ? { cli: value['cli'] as string } : {}),
    executors: (value['executors'] as string[] | undefined) ?? [],
    directory: dirname(configPath),
    path: configPath,
  };
}

function findConfig(start: string): string | undefined {
  let directory = start;
  while (true) {
    const candidate = join(directory, 'flows.json');
    try {
      accessSync(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parsePath(directory).root) return undefined;
    directory = parent;
  }
}

function systemProbes(flowDirectory: string, config: ProjectConfig): PreflightProbes {
  return {
    cli: (cli, source) => probeCli(cli, source === 'project' ? config.directory : flowDirectory),
    executor: (trigger) => config.executors.includes(trigger.executor),
    command: (binary) => executableExists(binary, flowDirectory),
  };
}

function probeCli(cli: string, directory: string): { exists: boolean; authenticated: boolean } {
  const executable = resolveExecutable(cli, directory);
  if (executable === undefined) return { exists: false, authenticated: false };
  const result = spawnSync(executable, ['auth', 'status'], {
    cwd: directory,
    stdio: 'ignore',
    timeout: 10_000,
  });
  const failure = classifySpawnFailure(result.error, result.signal, 10_000);
  if (failure !== undefined) throw failure;
  return { exists: true, authenticated: result.status === 0 };
}

function resolveExecutable(command: string, directory: string): string | undefined {
  if (command.includes('/') || isAbsolute(command)) {
    const path = isAbsolute(command) ? command : resolve(directory, command);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      return undefined;
    }
  }
  const result = spawnSync('which', [command], { encoding: 'utf8', timeout: 5_000 });
  const failure = classifySpawnFailure(result.error, result.signal, 5_000);
  if (failure !== undefined) throw failure;
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function classifySpawnFailure(
  error: Error | undefined,
  signal: NodeJS.Signals | null,
  timeoutMs: 5_000 | 10_000,
): CliProbeError | undefined {
  if (error !== undefined) {
    const detail = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ? `timeout:${timeoutMs}ms` as const
      : 'spawn_failed' as const;
    return new CliProbeError(detail);
  }
  return signal === null ? undefined : new CliProbeError(`signal:${signal}`);
}

function executableExists(command: string, directory: string): boolean {
  return resolveExecutable(command, directory) !== undefined;
}

function emitInputFailure(failure: CheckFailure, path: string | undefined, json: boolean, io: CliIo): number {
  const report: CheckReport = {
    ok: false,
    ...(path !== undefined ? { path } : {}),
    resolutions: [],
    diagnostics: [{ severity: 'refusal', kind: failure.kind, message: failure.message }],
  };
  emitReport(report, json, io);
  return 2;
}

function emitReport(report: CheckReport, json: boolean, io: CliIo): void {
  for (const diagnostic of report.diagnostics) {
    io.stderr(`${diagnostic.severity === 'warning' ? 'WARNING' : 'REFUSED'} [${diagnostic.kind}] ${diagnostic.message}`);
  }
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

function kernelDialectMarker(value: unknown): string | undefined {
  if (!isObject(value) || !Array.isArray(value['steps'])) return undefined;
  // Select the boundary dialect from snake_case keys or nested verification /
  // policy shapes. Compiler-emitted kernel specs always carry `retry`; the
  // additional shapes cover other producers that omit default fields. A
  // document with no marker is ambiguous and is validated as authoring input.
  const kernelStepKeys = ['depends_on', 'max_iterations', 'retry', 'timeout_ms', 'recovery_mode'];
  const kernelBudgetKeys = ['max_tokens_in', 'max_tokens_out', 'max_dollars'];
  const kernelVerificationKeys = ['output_contains', 'json_schema'];
  const kernelPermissionKeys = ['file_globs', 'network_allowlist', 'access_preset'];
  const budget = firstPresentKey(value['budget'], kernelBudgetKeys);
  if (budget !== undefined) return `spec.budget.${budget}`;
  for (const [index, step] of value['steps'].entries()) {
    if (!isObject(step)) continue;
    const stepKey = firstPresentKey(step, kernelStepKeys);
    if (stepKey !== undefined) return `spec.steps[${index}].${stepKey}`;
    const verification = firstPresentKey(step['verification'], kernelVerificationKeys);
    if (verification !== undefined) return `spec.steps[${index}].verification.${verification}`;
    const permission = firstPresentKey(step['permissions'], kernelPermissionKeys);
    if (permission !== undefined) return `spec.steps[${index}].permissions.${permission}`;
  }
  return undefined;
}

function firstPresentKey(value: unknown, keys: readonly string[]): string | undefined {
  return isObject(value) ? keys.find((key) => key in value) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDirectInvocation(entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === import.meta.url;
  } catch {
    // A missing, deleted, or unreadable argv[1] is treated as an import. The
    // module stays safe to load without guessing that an unrelated host is us.
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2));
}
