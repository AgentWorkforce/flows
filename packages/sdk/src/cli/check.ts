import { communicationInstruction } from '../communication/spec.js';
import { checkCommunicationEnvironment } from '../communication/preflight.js';
import { agentEnvironment, brokerEnvironment } from '../communication/environment.js';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { CompileError, compileSpec, kernelToAuthoring } from '../compile.js';
import { agentWorkerDiagnostics } from './check-worker-surface.js';
import { helperReady } from '../yaml-helper-effect.js';
import { flowRequirements, type FlowRequirements } from '../flow-requirements.js';
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
  type CliProbeOutcome,
  type PreflightDiagnostic,
  type PreflightProbes,
} from '../preflight.js';

export interface ProjectConfig {
  deploy?: { bucket: string };
  mcp?: Record<string, McpServerConfig>;
  cli?: string;
  executors: string[];
  /**
   * Exact model allowlist. Only a flows.json that DECLARES `models` is a
   * registry that preflight enforces: `{"cli":"claude"}` alone names the CLI
   * and leaves model policy to the adapter defaults, exactly as no flows.json
   * would. Otherwise every scaffolded project (`flows create` writes only
   * `cli`) refuses its adapter's own default model as "not listed".
   */
  models: string[];
  modelRegistryPath?: string;
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
  /** Authored `schedule.*` handlers and the `flows.tick` subscription each lowers to. */
  schedules?: ScheduleInspection[];
  /** Integrations, harnesses and MCP servers the flow declares it needs (`flow-requirements.ts`). */
  requirements?: FlowRequirements;
  /** Schema-2 flow extensions composed onto the authored flow, in lock order (`flow-extension-loader.ts`). */
  extensions?: ExtensionInspection[];
  /** Base hook points and which plugins implement them. */
  hooks?: HookInspection;
  diagnostics: Array<PreflightDiagnostic | CheckInputDiagnostic | CheckWarningDiagnostic>;
}

export interface ExtensionInspection {
  name: string;
  version: string;
  /** Canonical `github:<owner>/<repo>@<sha>#<path>`. */
  ref: string;
  digest: string;
  /** How many `.on()` handlers it appends after the base flow's own. */
  handlers: number;
  /** Hook names this extension implements, in manifest order. */
  hooks?: readonly string[];
}

export interface HookInspection {
  /** Names the base flow header declares. */
  declared: readonly string[];
  /** Plugin implementations in lock order. */
  implementations: readonly { hook: string; plugin: string }[];
}

export interface ScheduleInspection {
  /** Position among the flow's handlers, so two identical declarations stay distinct. */
  handler: number;
  cron?: string;
  tz?: string;
  intervalMs?: number;
  epochMs?: number;
  staleAfterMs?: number;
  scheduleId: string;
  /** Present when the local tick runner cannot drive it (only a cron-aware runner can). */
  localUnsupported?: string;
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

/**
 * Facts about the *caller*, not about the spec, that change which diagnostics
 * apply. Preflight stays a pure function of the spec plus environment probes;
 * anything that depends on how the flow is about to be invoked opts in here.
 */
export interface CheckInvocation {
  /**
   * Report `agent_worker_unresolved` when the spec has `agent` steps.
   *
   * Only `flows check` sets this. `flows run` attaches its own worker under
   * `--local-agent` and knows the answer, `flows build` and `flows deploy`
   * check a spec that will run elsewhere, and an SDK caller that reaches
   * `checkAuthoredFlow` directly is generally running a worker already —
   * warning any of them would be noise about a question they have answered.
   */
  warnUnresolvedAgentWorker?: boolean;
}

export class CheckFailure extends Error {
  constructor(readonly kind: CheckFailureKind, message: string) {
    super(message);
  }
}

/** Validate and preflight one working-tree spec without starting a run. */
export function checkFlow(path: string, invocation: CheckInvocation = {}): CheckExecution {
  const absolutePath = resolve(path);
  try {
    const source = readFlowSource(absolutePath);
    const hint = path.endsWith('.flow.yaml') && !/^\uFEFF?[ \t]*# yaml-language-server:/.test(source)
      ? [{ severity: 'warning' as const, kind: 'editor_schema_missing' as const,
          message: 'For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json' }]
      : [];
    let execution: CheckExecution;
    try {
      execution = checkAuthoredFlow(readFlow(source, absolutePath), path, undefined, invocation);
    } catch (error) {
      if (!(error instanceof CheckFailure)) throw error;
      execution = { report: inputFailureReport(error, path) };
    }
    // The editor-schema hint is a documentation nudge, emitted for every
    // .flow.yaml without a first-line yaml-language-server comment.
    // Firing it even when a refusal is present is deliberate: an editor
    // showing squiggles on this file should still tell the author how to
    // wire the schema, so the next edit gets real-time feedback.
    execution.report.diagnostics.push(...hint);
    return execution;
  } catch (error) {
    const failure = error instanceof CheckFailure
      ? error
      : new CheckFailure('invalid_spec', `Flow "${path}" could not be checked as a Relayflow spec.`);
    return { report: inputFailureReport(failure, path) };
  }
}

/** Requirements never turn a preflight refusal into an unrelated exception. */
function safeRequirements(authoring: FlowSpec, projectCli: string | undefined): FlowRequirements | undefined {
  try {
    return flowRequirements(authoring, projectCli === undefined ? {} : { projectCli });
  } catch {
    return undefined;
  }
}

/** Preflight a validated authored flow through the same path as YAML/JSON. */
export function checkAuthoredFlow(
  authoring: FlowSpec,
  path: string,
  projectConfig?: ProjectConfig,
  invocation: CheckInvocation = {},
  cliProbeCache?: Map<string, CliProbeOutcome>,
): CheckExecution {
  const absolutePath = resolve(path);
  try {
    const config = projectConfig ?? readProjectConfig(dirname(absolutePath));
    const probes = systemProbes(dirname(absolutePath), config);
    const result = preflight(authoring, {
      ...(cliProbeCache === undefined ? {} : { cliProbeCache }),
      projectCli: config.cli,
      projectConfigPath: config.path,
      projectSearchStart: dirname(absolutePath),
      models: config.models,
      ...(config.modelRegistryPath !== undefined ? { modelRegistryPath: config.modelRegistryPath } : {}),
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
    if (flow?.steps.some(step => step.type === 'agent' && communicationInstruction(step.instruction))) {
      try { checkCommunicationEnvironment(flow); }
      catch (error) {
        result.ok = false;
        result.diagnostics.push({ severity: 'refusal', kind: 'probe_failed',
          message: error instanceof Error ? error.message : 'Communication environment could not be checked.' });
      }
      result.diagnostics.push({ severity: 'warning', kind: 'budget_unmetered',
        message: 'Managed communication sessions do not report token or dollar usage. Budget ceilings cannot bound their spend; communication.timeoutMs bounds their duration.' });
    }
    // Reported whatever preflight concluded. An environment refusal (a missing
    // CLI, an unknown model) is fixed and rerun; the worker question is still
    // open on the next pass, and staying silent about it here is what made an
    // author meet it one dead run at a time.
    const workerSurface = invocation.warnUnresolvedAgentWorker === true
      ? agentWorkerDiagnostics(authoring)
      : [];
    return {
      report: {
        ok: result.ok,
        path,
        ...(config.path !== undefined ? { projectConfigPath: config.path } : {}),
        gates: result.gates,
        resolutions: result.resolutions,
        diagnostics: [...result.diagnostics, ...workerSurface],
        requirements: safeRequirements(authoring, config.cli),
      },
      ...(result.ok && flow !== undefined ? { flow } : {}),
    };
  } catch (error) {
    const failure = error instanceof CheckFailure
      ? error
      : new CheckFailure('invalid_spec', `Flow "${path}" could not be checked as a Relayflow spec.`);
    return { report: inputFailureReport(failure, path) };
  }
}

/**
 * Build-time gate that runs the same preflight pipeline as `checkFlow`
 * but with deferred probes — a build machine is not the deployment target,
 * so `cli`/`command`/`executor` existence is checked at run-time, not here.
 *
 * "Build-provable" refusals (unknown model, `use:` unresolved, invalid
 * verification, missing bundle assets, budget syntax, etc.) still surface,
 * because they are properties of the flow spec, not of the build host.
 */
export async function checkBuildableFlow(path: string): Promise<CheckExecution> {
  const absolutePath = resolve(path);
  try {
    const authored = /\.(?:[cm]?[jt]s)$/.test(path);
    if (authored) {
      // TS flows are gated by `buildFlow` itself, which runs
      // `buildTypescript` to compile the authored spec and then invokes
      // preflight with deferred probes at the same refusal threshold as
      // this gate. Running `checkTypeScriptFlow` here would need
      // `@relayflows/surface` to be resolvable from the flow's directory,
      // which is not a build-time invariant. Return an ok report so the
      // gate delegates to `buildFlow`'s inline preflight.
      return {
        report: { ok: true, path, gates: [], resolutions: [], diagnostics: [] },
      };
    }
    const source = readFlowSource(absolutePath);
    const authoring: FlowSpec = readFlow(source, absolutePath);
    const config = readProjectConfig(dirname(absolutePath));
    const deferred: PreflightProbes = {
      cli: () => { throw new Error('deferred to deployment'); },
      executor: () => { throw new Error('deferred to deployment'); },
      command: () => { throw new Error('deferred to deployment'); },
    };
    const result = preflight(authoring, {
      ...(config.cli !== undefined ? { projectCli: config.cli } : {}),
      ...(config.path !== undefined ? { projectConfigPath: config.path } : {}),
      projectSearchStart: dirname(absolutePath),
      models: config.models,
      ...(config.modelRegistryPath !== undefined ? { modelRegistryPath: config.modelRegistryPath } : {}),
      probes: deferred,
    });
    // Refusals rooted in build-machine environment probes (`probe_failed`)
    // are excluded from the build gate — the build host is not the
    // deployment target, and those checks are re-run at `flows run`.
    const diagnostics = result.diagnostics.filter(
      (d) => !(d.severity === 'refusal' && d.kind === 'probe_failed'),
    );
    const ok = !diagnostics.some((d) => d.severity === 'refusal');
    return {
      report: {
        ok,
        path,
        ...(config.path !== undefined ? { projectConfigPath: config.path } : {}),
        gates: result.gates,
        resolutions: result.resolutions,
        diagnostics,
      },
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
  if (!isObject(value) || Object.keys(value).some((key) => !['cli', 'executors', 'models', 'mcp', 'deploy', 'plugins'].includes(key))) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" expects only cli, executors, models, mcp, deploy, and plugins.`);
  }
  if (value['deploy'] !== undefined && (!isObject(value['deploy'])
    || Object.keys(value['deploy']).some(key => key !== 'bucket')
    || !isNonEmptyString(value['deploy']['bucket']))) {
    throw new CheckFailure('config_invalid', `Project config "${configPath}" has invalid deploy.bucket.`);
  }
  if (value['plugins'] !== undefined && (!Array.isArray(value['plugins']) || !value['plugins'].every(isNonEmptyString))) {
    throw new CheckFailure('config_invalid', 'Project plugins must be package names.');
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
    ...(value['deploy'] !== undefined ? { deploy: value['deploy'] as { bucket: string } } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(value['cli'] !== undefined ? { cli: value['cli'] as string } : {}),
    executors: (value['executors'] as string[] | undefined) ?? [],
    models: (value['models'] as string[] | undefined) ?? [],
    ...(value['models'] !== undefined ? { modelRegistryPath: configPath } : {}),
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
    helper: helperReady,
    cli: (cli, source, model, execution) => probeCli(cli, source === 'project' ? config.directory : flowDirectory, model, execution),
    executor: (trigger) => config.executors.includes(trigger.executor),
    // A deterministic step runs in the daemon's working directory — the
    // directory `flows run` was invoked from, or Cloud's code mount — not in
    // the flow file's. Probing `./x` against the flow's directory answered a
    // question the kernel never asks, and refused a Cloud run whose synced
    // tree held the script while its source sat in the state directory.
    command: (binary) => executableExists(binary, process.cwd()),
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
      return { ...step, cli: canonicalCli(resolution.cli, directory),
        ...(resolution.modelSource === 'adapter' && resolution.model !== undefined
          ? { model: resolution.model } : {}) };
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
  execution?: 'managed',
): CliProbeResult {
  const executable = resolveExecutable(cli, directory);
  if (executable === undefined) return { exists: false, authenticated: false };
  const kind = cliAdapterKind(executable);
  // Relay owns interactive CLI launch/injection. Its generic PTY path is not
  // the headless wrapper protocol; do not demand that protocol from Gemini,
  // Cursor, OpenCode, or other interactive tools. Never invent an auth pass.
  if (execution === 'managed' && kind === 'relayflows-wrapper-v1') {
    return { exists: true, supported: true, authenticated: 'unverified' };
  }
  const environment = execution === 'managed'
    ? { ...brokerEnvironment(process.env), ...agentEnvironment(executable) } : process.env;
  const probe = (invocation: CliInvocation) => runProbe(executable, directory, invocation, environment);
  const identification = adapterIdentification(kind);
  const identified = probe(identification.invocation);
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
      authenticated: probe(auth).status === 0,
      authCommand,
    };
  }

  const scoped = modelReadinessProbe(kind, model);
  const modelCommand = displayInvocation(cli, scoped);
  // A successful real provider round trip (or identified wrapper probe)
  // proves both auth and exact-model access. On failure, run the adapter's
  // actual auth command solely to classify auth vs model access truthfully.
  if (probe(scoped).status === 0) {
    return {
      exists: true,
      supported: true,
      authenticated: true,
      modelAvailable: true,
      authCommand,
      modelCommand,
    };
  }
  const authProbe = probe(auth);
  const authenticated = authProbe.status === 0;
  return {
    exists: true,
    supported: true,
    authenticated,
    modelAvailable: false,
    authCommand,
    modelCommand,
    // Only on failure: on success there is nothing to explain, and the output
    // is the most identity-bearing thing this function touches.
    ...(authenticated
      ? {}
      : {
        authExitCode: authProbe.status,
        authFailureDetail: redactProbeOutput(
          `${authProbe.stderr}${authProbe.stdout}`,
        ).trim().slice(0, 500),
      }),
  };
}

/**
 * Redact anything that looks like a credential or an account identifier.
 *
 * `auth status` output is diagnostic, but it is also the one place an account
 * email, org id or token fragment can appear. The point of surfacing it is to
 * say WHY a probe failed, which survives redaction; leaking an identity into a
 * refusal message that gets pasted into issues does not.
 */
function redactProbeOutput(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .replace(/\b(sk|pk|oat|rt)[-_][A-Za-z0-9._-]{8,}/gi, '<redacted-token>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<redacted-hex>');
}

function runProbe(
  executable: string,
  directory: string,
  invocation: CliInvocation,
  environment: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const env = { ...environment };
  delete env[MODEL_ENV];
  if (invocation.modelEnv !== undefined) env[MODEL_ENV] = invocation.modelEnv;
  const result = spawnSync(executable, invocation.args, {
    cwd: directory,
    encoding: 'utf8',
    // stderr was 'ignore'. A failing `auth status` writes its reason there, so
    // discarding it made every authentication refusal structurally
    // undiagnosable: the refusal could say a probe exited non-zero and never
    // what it said. Captured, then redacted at the point of use.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: invocation.timeoutMs,
    env,
  });
  const failure = classifySpawnFailure(result.error, result.signal, invocation.timeoutMs);
  if (failure !== undefined) throw failure;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr ?? '',
  };
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
