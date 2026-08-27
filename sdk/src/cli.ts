#!/usr/bin/env node

import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { CompileError, compileSpec } from './compile.js';
import type { FlowSpec } from './spec.js';
import type { CheckFailureKind } from './failure-kinds.js';
import {
  preflight,
  type PreflightDiagnostic,
  type PreflightProbes,
} from './preflight.js';

interface ProjectConfig {
  cli?: string;
  executors: string[];
  directory: string;
}

interface CheckReport {
  ok: boolean;
  path?: string;
  resolutions: ReturnType<typeof preflight>['resolutions'];
  diagnostics: Array<PreflightDiagnostic | CheckInputDiagnostic>;
}

interface CheckInputDiagnostic {
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
  if (parsed instanceof CheckFailure) return emitInputFailure(parsed, parsed.kind === 'invalid_invocation' ? undefined : args.at(-1), false, io);

  const absolutePath = resolve(parsed.path);
  try {
    const flow = readFlow(absolutePath);
    const config = readProjectConfig(dirname(absolutePath));
    const probes = systemProbes(dirname(absolutePath), config);
    const result = preflight(flow, { projectCli: config.cli, probes });
    const report: CheckReport = {
      ok: result.ok,
      path: parsed.path,
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
    const authoring = isKernelSpec(parsed) ? kernelToAuthoring(parsed) : parsed;
    return compileSpec(authoring);
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    if (error instanceof CompileError) {
      throw new CheckFailure('invalid_spec', error.errors.join('; '));
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
  if (result.error !== undefined) throw new Error('probe failed');
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
  return result.status === 0 ? result.stdout.trim() : undefined;
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
    io.stdout(`RESOLVED step "${resolution.stepId}" cli "${resolution.cli}" from ${resolution.source}`);
  }
  if (report.ok) io.stdout(`CHECK PASSED ${report.path ?? ''}`.trimEnd());
}

function isKernelSpec(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value['steps'])) return false;
  return value['steps'].some((step) => isObject(step) && ('depends_on' in step || 'max_iterations' in step));
}

function kernelToAuthoring(value: unknown): unknown {
  const root = requireObject(value, ['version', 'name', 'description', 'cli', 'triggers', 'steps', 'budget']);
  const steps = requireArray(root['steps']).map(kernelStepToAuthoring);
  return {
    ...copy(root, ['version', 'name', 'description', 'cli', 'triggers']),
    steps,
    ...(root['budget'] !== undefined ? { budget: kernelBudgetToAuthoring(root['budget']) } : {}),
  };
}

function kernelStepToAuthoring(value: unknown): unknown {
  const unionKeys = [
    'id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification',
    'command', 'timeout_ms', 'prompt', 'model', 'cli', 'instruction',
    'recovery_mode', 'surfaces', 'permissions',
  ] as const;
  const step = requireObject(value, unionKeys);
  const type = step['type'];
  const commonKeys = ['id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification'] as const;
  const typeKeys = type === 'deterministic'
    ? ['command', 'timeout_ms'] as const
    : type === 'llm'
      ? ['prompt', 'model', 'cli'] as const
      : type === 'agent'
        ? ['instruction', 'cli', 'recovery_mode', 'surfaces', 'permissions'] as const
        : [];
  assertKeys(step, [...commonKeys, ...typeKeys]);
  if (step['retry'] !== undefined) validateKernelRetry(step['retry']);
  const common = {
    id: step['id'],
    type,
    ...(step['depends_on'] !== undefined ? { dependsOn: step['depends_on'] } : {}),
    ...(step['max_iterations'] !== undefined ? { maxIterations: step['max_iterations'] } : {}),
    ...kernelVerificationToAuthoring(step['verification']),
  };
  if (type === 'deterministic') {
    return { ...common, command: step['command'], ...(step['timeout_ms'] !== undefined ? { timeoutMs: step['timeout_ms'] } : {}) };
  }
  if (type === 'llm') {
    return { ...common, prompt: step['prompt'], ...copy(step, ['model', 'cli']) };
  }
  if (type === 'agent') {
    return {
      ...common,
      instruction: step['instruction'],
      ...(step['recovery_mode'] !== undefined ? { recoveryMode: step['recovery_mode'] } : {}),
      ...copy(step, ['cli', 'surfaces']),
      ...(step['permissions'] !== undefined ? { permissions: kernelPermissionsToAuthoring(step['permissions']) } : {}),
    };
  }
  return common;
}

function validateKernelRetry(value: unknown): void {
  const retry = requireObject(value, [
    'initial_backoff_ms', 'max_backoff_ms', 'multiplier', 'jitter_percent',
  ]);
  const initial = retry['initial_backoff_ms'];
  const maximum = retry['max_backoff_ms'];
  const multiplier = retry['multiplier'];
  const jitter = retry['jitter_percent'];
  if (![initial, maximum, multiplier, jitter].every(isNonNegativeInteger)
    || (multiplier as number) === 0
    || (jitter as number) > 100
    || (maximum as number) < (initial as number)) {
    throw new CheckFailure('invalid_spec', 'Compiled spec contains an invalid retry policy.');
  }
}

function kernelVerificationToAuthoring(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const verification = requireObject(value, ['output_contains', 'json_schema']);
  if (verification['output_contains'] !== undefined && verification['json_schema'] !== undefined) {
    throw new CheckFailure('invalid_spec', 'Compiled verification may not contain two gates in spec v0.1.0.');
  }
  if (verification['output_contains'] !== undefined) {
    return { verification: { type: 'output_contains', value: verification['output_contains'] } };
  }
  if (verification['json_schema'] !== undefined) {
    return { verification: { type: 'json_schema', schema: verification['json_schema'] } };
  }
  return {};
}

function kernelBudgetToAuthoring(value: unknown): unknown {
  const budget = requireObject(value, ['max_tokens_in', 'max_tokens_out', 'max_dollars']);
  return {
    ...(budget['max_tokens_in'] !== undefined ? { maxTokensIn: budget['max_tokens_in'] } : {}),
    ...(budget['max_tokens_out'] !== undefined ? { maxTokensOut: budget['max_tokens_out'] } : {}),
    ...(budget['max_dollars'] !== undefined ? { maxDollars: budget['max_dollars'] } : {}),
  };
}

function kernelPermissionsToAuthoring(value: unknown): unknown {
  const permissions = requireObject(value, ['file_globs', 'network_allowlist', 'access_preset']);
  return {
    ...(permissions['file_globs'] !== undefined ? { fileGlobs: permissions['file_globs'] } : {}),
    ...(permissions['network_allowlist'] !== undefined ? { networkAllowlist: permissions['network_allowlist'] } : {}),
    ...(permissions['access_preset'] !== undefined ? { accessPreset: permissions['access_preset'] } : {}),
  };
}

function requireObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) {
    throw new CheckFailure('invalid_spec', 'Compiled spec contains an unknown or malformed object.');
  }
  assertKeys(value, allowed);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CheckFailure('invalid_spec', 'Compiled spec contains an unknown or malformed object.');
  }
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new CheckFailure('invalid_spec', 'Compiled spec steps must be an array.');
  return value;
}

function copy(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
