import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { CompileError, compileSpec, kernelToAuthoring } from '../compile.js';
import {
  adapterIdentification,
  authenticationProbe,
  cliAdapterKind,
  displayInvocation,
  modelReadinessProbe,
  type CliInvocation,
} from '../cli-adapter.js';
import { MODEL_ENV } from '../worker-cli.js';
import { modelNameError } from '../model-name.js';
import type { FlowSpec } from '../spec.js';
import type { McpServerConfig } from '../spec.js';
import { parseMcpConfig } from '../mcp-config.js';
import type { StepGateInspection } from '../gate-contract.js';
import type { CheckFailureKind, CheckWarningKind } from '../failure-kinds.js';
import {
  preflight,
  CliProbeError,
  type CliResolution,
  type CliProbeResult,
  type PreflightDiagnostic,
  type PreflightProbes,
} from '../preflight.js';

export interface ProjectConfig {
  mcp?: Record<string, McpServerConfig>;
  cli?: string;
  executors: string[];
  models: string[];
  directory: string;
  path?: string;
}

export interface CheckReport {
  mcpTools?: Readonly<Record<string, readonly string[]>>;
  ok: boolean;
  path?: string;
  projectConfigPath?: string;
  gates: StepGateInspection[];
  resolutions: CliResolution[];
  diagnostics: Array<PreflightDiagnostic | CheckInputDiagnostic | CheckWarningDiagnostic>;
}

export interface CheckWarningDiagnostic {
  severity: 'warning';
  kind: CheckWarningKind;
  message: string;
}

export interface CheckInputDiagnostic {
  severity: 'refusal';
  kind: CheckFailureKind;
  message: string;
}

export interface CheckExecution {
  report: CheckReport;
  flow?: FlowSpec;
}

class CheckFailure extends Error {
  constructor(readonly kind: CheckFailureKind, message: string) {
    super(message);
  }
}

/** Validate and preflight one working-tree spec without starting a run. */
export function checkFlow(path: string): CheckExecution {
  const absolutePath = resolve(path);
  try {
    const source = readFlowSource(absolutePath);
    const hint = path.endsWith('.flow.yaml') && !/^\uFEFF?[ \t]*# yaml-language-server:/.test(source)
      ? [{ severity: 'warning' as const, kind: 'editor_schema_missing' as const,
          message: 'For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json' }]
      : [];
    let execution: CheckExecution;
    try {
      execution = checkAuthoredFlow(readFlow(source, absolutePath), path);
    } catch (error) {
      if (!(error instanceof CheckFailure)) throw error;
      execution = { report: inputFailureReport(error, path) };
    }
    // The editor-schema hint is noise once a real diagnostic is already
    // present -- an author who can't get past a refusal shouldn't also be
    // told to add a yaml-language-server comment. Suppress it unless the
    // report is otherwise clean.
    if (execution.report.ok && !execution.report.diagnostics.some(d => d.severity === 'refusal')) {
      execution.report.diagnostics.push(...hint);
    }
    return execution;
  } catch (error) {
    const failure = error instanceof CheckFailure
      ? error
      : new CheckFailure('invalid_spec', `Flow "${path}" could not be checked as a Relayflow spec.`);
    return { report: inputFailureReport(failure, path) };
  }
}

/** Preflight a validated authored flow through the same path as YAML/JSON. */
export function checkAuthoredFlow(authoring: FlowSpec, path: string): CheckExecution {
  const absolutePath = resolve(path);
  try {
    const config = readProjectConfig(dirname(absolutePath));
    const probes = systemProbes(dirname(absolutePath), config);
    const result = preflight(authoring, {
      projectCli: config.cli,
      projectConfigPath: config.path,
      projectSearchStart: dirname(absolutePath),
      models: config.models,
      ...(config.path !== undefined ? { modelRegistryPath: config.path } : {}),
      probes,
    });
    const flow = result.ok
      ? bindResolvedCliPaths(
          compileSpec(authoring),
          result.resolutions,
          dirname(absolutePath),
          config.directory,
        )
      : undefined;
    return {
      report: {
        ok: result.ok,
        path,
        ...(config.path !== undefined ? { projectConfigPath: config.path } : {}),
        gates: result.gates,
        resolutions: result.resolutions,
        diagnostics: result.diagnostics,
      },
      ...(flow !== undefined ? { flow } : {}),
    };
  } catch (error) {
    const failure = error instanceof CheckFailure
      ? error
      : new CheckFailure('invalid_spec', `Flow "${path}" could not be checked as a Relayflow spec.`);
    return { report: inputFailureReport(failure, path) };
  }
}

export function inputFailureReport(
  failure: { kind: CheckFailureKind; message: string },
  path?: string,
): CheckReport {
  return {
    ok: false,
    ...(path !== undefined ? { path } : {}),
    gates: [],
    resolutions: [],
    diagnostics: [{ severity: 'refusal', kind: failure.kind, message: failure.message }],
  };
}

function readFlowSource(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new CheckFailure('input_unreadable', `Flow "${path}" is not readable.`);
  }
}

function readFlow(source: string, path: string): FlowSpec {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    throw new CheckFailure('invalid_spec', `Flow "${path}" contains invalid YAML or JSON.`);
  }

  try {
    const marker = kernelDialectMarker(parsed);
    const authoring = marker === undefined ? parsed : kernelToAuthoring(parsed);
    // Public preflight owns the first validation pass. Returning raw authoring
    // here preserves named-agent provenance until every declaration is checked.
    return authoring as FlowSpec;
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

export function readProjectConfig(start: string): ProjectConfig {
  const configPath = findConfig(start);
  if (configPath === undefined) return { executors: [], models: [], directory: start };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" is not valid JSON.`);
  }
  if (!isObject(value) || Object.keys(value).some((key) => !['cli', 'executors', 'models', 'mcp'].includes(key))) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" expects only cli, executors, models, and mcp.`);
  }
  if (value['cli'] !== undefined && !isNonEmptyString(value['cli'])) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" has an invalid cli.`);
  }
  if (value['executors'] !== undefined && (!Array.isArray(value['executors']) || !value['executors'].every(isNonEmptyString))) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" has invalid executors.`);
  }
  if (value['models'] !== undefined) {
    if (!Array.isArray(value['models'])) {
      throw new CheckFailure('config_invalid', `Project config "${configPath}" has invalid models; expected an exact string allowlist.`);
    }
    for (const [index, model] of value['models'].entries()) {
      const problem = modelNameError(model);
      if (problem !== undefined) {
        throw new CheckFailure('config_invalid', `Project config "${configPath}" models[${index}]: ${problem}.`);
      }
    }
    if (new Set(value['models']).size !== value['models'].length) {
      throw new CheckFailure('config_invalid', `Project config "${configPath}" has duplicate models.`);
    }
  }
  let mcp: Record<string, McpServerConfig> | undefined;
  if (value['mcp'] !== undefined) {
    try { mcp = parseMcpConfig(value['mcp']); }
    catch (error) {
      throw new CheckFailure('config_invalid', `Project config "${configPath}": ${(error as Error).message}.`);
    }
    for (const entry of Object.values(mcp)) {
      if ('command' in entry) entry.command = resolveExecutable(entry.command, dirname(configPath))
        ?? canonicalCli(entry.command, dirname(configPath));
    }
  }
  return {
    ...(mcp !== undefined ? { mcp } : {}),
    ...(value['cli'] !== undefined ? { cli: value['cli'] as string } : {}),
    executors: (value['executors'] as string[] | undefined) ?? [],
    models: (value['models'] as string[] | undefined) ?? [],
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
    cli: (cli, source, model) => probeCli(cli, source === 'project' ? config.directory : flowDirectory, model),
    executor: (trigger) => config.executors.includes(trigger.executor),
    command: (binary) => executableExists(binary, flowDirectory),
  };
}

function bindResolvedCliPaths(
  flow: FlowSpec,
  resolutions: readonly CliResolution[],
  flowDirectory: string,
  configDirectory: string,
): FlowSpec {
  const byStep = new Map(resolutions.map((resolution) => [resolution.stepId, resolution]));
  return {
    ...flow,
    steps: flow.steps.map((step) => {
      if (step.type === 'deterministic') return step;
      const resolution = byStep.get(step.id);
      if (resolution === undefined) return step;
      const directory = resolution.source === 'project' ? configDirectory : flowDirectory;
      return { ...step, cli: canonicalCli(resolution.cli, directory) };
    }),
  };
}

function canonicalCli(cli: string, directory: string): string {
  if (isAbsolute(cli) || (!cli.includes('/') && !cli.includes('\\'))) return cli;
  return resolve(directory, cli);
}

function probeCli(
  cli: string,
  directory: string,
  model?: string,
): CliProbeResult {
  const executable = resolveExecutable(cli, directory);
  if (executable === undefined) return { exists: false, authenticated: false };
  const kind = cliAdapterKind(executable);
  const identification = adapterIdentification(kind);
  const identified = runProbe(executable, directory, identification.invocation);
  if (
    identified.status !== 0
    || (identification.expectedStdout !== undefined
      && identified.stdout.trim() !== identification.expectedStdout)
  ) {
    return { exists: true, supported: false, authenticated: false };
  }
  const auth = authenticationProbe(kind);
  const authCommand = displayInvocation(cli, auth);
  if (model === undefined) {
    return {
      exists: true,
      supported: true,
      authenticated: runProbe(executable, directory, auth).status === 0,
      authCommand,
    };
  }

  const scoped = modelReadinessProbe(kind, model);
  const modelCommand = displayInvocation(cli, scoped);
  // A successful real provider round trip (or identified wrapper probe)
  // proves both auth and exact-model access. On failure, run the adapter's
  // actual auth command solely to classify auth vs model access truthfully.
  if (runProbe(executable, directory, scoped).status === 0) {
    return {
      exists: true,
      supported: true,
      authenticated: true,
      modelAvailable: true,
      authCommand,
      modelCommand,
    };
  }
  const authStatus = runProbe(executable, directory, auth).status;
  return {
    exists: true,
    supported: true,
    authenticated: authStatus === 0,
    modelAvailable: false,
    authCommand,
    modelCommand,
  };
}

function runProbe(
  executable: string,
  directory: string,
  invocation: CliInvocation,
): { status: number | null; stdout: string } {
  const env = { ...process.env };
  delete env[MODEL_ENV];
  if (invocation.modelEnv !== undefined) env[MODEL_ENV] = invocation.modelEnv;
  const result = spawnSync(executable, invocation.args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: invocation.timeoutMs,
    env,
  });
  const failure = classifySpawnFailure(result.error, result.signal, invocation.timeoutMs);
  if (failure !== undefined) throw failure;
  return { status: result.status, stdout: result.stdout };
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
  timeoutMs: number,
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

function kernelDialectMarker(value: unknown): string | undefined {
  if (!isObject(value) || !Array.isArray(value['steps'])) return undefined;
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
