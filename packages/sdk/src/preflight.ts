import { communicationInstruction } from './communication/spec.js';
import { loadPlugins, type LoadedPlugin } from './plugin-loader.js';
import { PluginError } from './plugin-manifest.js';
import type { FlowSpec, StepSpec, TriggerSpec, McpServerConfig } from './spec.js';
import { McpError, openMcpSession, type McpDiagnostic } from './mcp-client.js';
import { BudgetSyntaxError } from './budget.js';
import { budgetDiagnostics } from './budget-preflight.js';
import { permissionsDiagnostics } from './permissions-preflight.js';
import type { TriggerSource } from '@relayflows/surface';
import { acceptsAnyOutput, inspectStepGate, type StepGateInspection } from './gate-contract.js';
import { compileSpec, CompileError } from './compile.js';
import { helperCall } from './yaml-helpers.js';
import { resolveCliModelSelection, type CliModelSource } from './cli-adapter.js';
import { isNamedGate, NAMED_GATE_FAILURE_KINDS, type NamedGateFailureKind } from './named-gates.js';
import { compileScopes, type ScopeInput, type MountRegistry } from './scope-compiler.js';
import { readMountRegistry } from './mount-registry.js';
import type {
  PreflightFailureKind,
  PreflightWarningKind,
} from './failure-kinds.js';

export type CliResolutionSource = 'step' | 'named' | 'flow' | 'project';

export interface CliResolution {
  stepId: string;
  cli: string;
  source: CliResolutionSource;
  /** Effective model probed with the CLI. */
  model?: string;
  /** Exact source selected by step > named agent > adapter default priority. */
  modelSource?: CliModelSource;
}

export interface CliProbeResult {
  exists: boolean;
  authenticated: boolean | 'unverified';
  /** False when a custom executable did not identify as a wrapper adapter. */
  supported?: boolean;
  /** Exact declared model passed the CLI's model-scoped readiness probe. */
  modelAvailable?: boolean;
  authCommand?: string;
  modelCommand?: string;
  /** Exit code of the authentication probe, when it failed. */
  authExitCode?: number | null;
  /**
   * Redacted output of a FAILED authentication probe.
   *
   * Present only on failure. Without it a `cli_unauthenticated` refusal can
   * state that a probe exited non-zero and never what it said, which makes an
   * intermittent probe failure impossible to tell apart from a genuinely
   * unauthenticated CLI.
   */
  authFailureDetail?: string;
}

export type CliProbeFailureDetail =
  | 'spawn_failed'
  | `timeout:${number}ms`
  | `signal:${string}`;

export class CliProbeError extends Error {
  constructor(readonly detail: CliProbeFailureDetail) {
    super('CLI probe failed');
  }
}

export type CliProbeOutcome =
  | { result: CliProbeResult }
  | { failure: CliProbeFailureDetail | null };

/**
 * Environment facts are injected; this module performs no I/O. A probe may
 * throw when its fact cannot be collected. Preflight catches that boundary and
 * emits `probe_failed` (or `command_unprovable` for a deterministic command).
 */
export interface PreflightProbes {
  /** Whether the provider's relayfile mount is available to the helper worker. */
  helper?(provider: string): boolean;
  /**
   * Resolve relative paths against the file implied by `source`, then probe
   * `auth status`. When the step declared a `model`, the probe runs with that
   * model in scope, so readiness answers "can this CLI use THIS model" rather
   * than the weaker "is this CLI authenticated at all".
   */
  cli(cli: string, source: CliResolutionSource, model?: string, execution?: 'managed'): CliProbeResult;
  executor(trigger: TriggerSpec): boolean;
  command(binary: string): boolean;
}

export interface PreflightOptions {
  pluginSearchStart?: string;
  /** Validated tools.mcp header and nearest flows.json connections. */
  mcpServers?: readonly string[];
  mcp?: Readonly<Record<string, McpServerConfig>>;
  projectCli?: string;
  projectConfigPath?: string;
  projectSearchStart?: string;
  /** Exact, project-owned model allowlist from the nearest flows.json. */
  models?: readonly string[];
  modelRegistryPath?: string;
  probeCache?: Map<string, CliProbeOutcome>;
  probes: PreflightProbes;
}

export interface PreflightRefusal {
  server?: string;
  cause?: McpDiagnostic;
  severity: 'refusal';
  kind: PreflightFailureKind;
  message: string;
  stepId?: string;
  cli?: string;
  agent?: string;
  model?: string;
  triggerId?: string;
  executor?: string;
  detail?: CliProbeFailureDetail;
  /** Author-facing validation errors when kind is `invalid_spec`. */
  errors?: string[];
}

export interface PreflightWarning {
  severity: 'warning';
  kind: PreflightWarningKind;
  message: string;
  stepId?: string;
}

export type PreflightDiagnostic = PreflightRefusal | PreflightWarning;

export interface PreflightResult {
  plugins?: readonly LoadedPlugin[];
  mcpTools?: Readonly<Record<string, readonly string[]>>;
  /**
   * True when no diagnostic is a refusal. `ok: true` may still carry warnings
   * (e.g. `budget_unmetered`); callers that report to a person must surface
   * `diagnostics`, not just branch on `ok`.
   */
  ok: boolean;
  gates: StepGateInspection[];
  resolutions: CliResolution[];
  diagnostics: PreflightDiagnostic[];
}

/** Pure declared-surface check, before opening a receiver or journal. */
export function preflightWebhookTriggers(
  triggers: readonly TriggerSource[],
  executors: readonly string[],
): PreflightRefusal[] {
  // Schedule sources are driven by the CLI's own tick runner, not an inbox
  // executor, so they need no flows.json registration.
  return [...new Set(triggers.filter(trigger => trigger.kind === 'webhook').map(trigger => trigger.name))]
    .filter(name => !executors.includes(name))
    .map(name => ({
      severity: 'refusal',
      kind: 'no_executor',
      executor: name,
      message: `webhook trigger "${name}" is not registered in flows.json`,
    }));
}

// Preserve the synchronous declarative API; an authored MCP declaration opts
// into asynchronous connection probes after the same pure refusal pass.
export function preflight(flow: FlowSpec, options: PreflightOptions & { mcpServers: readonly string[] }): Promise<PreflightResult>;
export function preflight(flow: FlowSpec, options: PreflightOptions & { mcpServers?: undefined }): PreflightResult;
export function preflight(flow: FlowSpec, options: PreflightOptions): PreflightResult | Promise<PreflightResult>;
export function preflight(flow: unknown, options: PreflightOptions): PreflightResult | Promise<PreflightResult> {
  const result = preflightSync(flow, options);
  if (options.mcpServers === undefined) return result;
  return probeMcp(result, options).then(async checked => {
    if (!checked.ok || options.pluginSearchStart === undefined) return checked;
    try { return { ...checked, plugins: await loadPlugins(options.pluginSearchStart) }; }
    catch (error) {
      if (!(error instanceof PluginError)) throw error;
      return { ...checked, ok: false, diagnostics: [...checked.diagnostics, { severity: 'refusal' as const, kind: error.code, message: error.message }] };
    }
  });
}

async function probeMcp(result: PreflightResult, options: PreflightOptions): Promise<PreflightResult> {
  if (!result.ok) return result;
  const inventory: Record<string, readonly string[]> = Object.create(null);
  for (const server of new Set(options.mcpServers)) {
    try {
      const session = await openMcpSession(options.mcp![server]!, 10_000);
      try { inventory[server] = Object.freeze(await session.listTools()); }
      finally { await session.close(); }
    } catch (error) {
      const cause = error instanceof McpError ? error.code : 'handshake_rejected';
      result.diagnostics.push({ severity: 'refusal', kind: 'mcp_unreachable', server, cause,
        message: `MCP server "${server}" is unreachable: ${cause}.` });
    }
  }
  return { ...result, ok: !result.diagnostics.some(d => d.severity === 'refusal'), mcpTools: Object.freeze(inventory) };
}

type ResolutionOptions = Omit<PreflightOptions, 'probes' | 'probeCache'>;

/** Resolve static declarations before any CLI, model, command or trigger probe. */
export function resolvePreflight(flow: unknown, options: ResolutionOptions): PreflightResult & {
  compiled?: import('./compile.js').CompiledFlowSpec;
} {
  // Compile before touching any environment fact. `compileSpec` snapshots raw
  // input into inert data, validates it against the closed authoring schema,
  // and lowers `output` sugar into its json_schema gate — so the gate plan
  // below describes what the kernel will actually judge, and no probe or gate
  // inspection ever reads a live accessor. The failure is a named refusal
  // rather than a thrown error (RFC covenant 2), which is the contract main
  // settled for this boundary.
  let compiled: import('./compile.js').CompiledFlowSpec;
  try {
    compiled = compileSpec(flow);
  } catch (error) {
    const errors = error instanceof CompileError
      ? error.errors
      : [error instanceof Error ? error.message : 'spec: expected JSON-compatible data'];
    // BudgetSyntaxError now flows through CompileError with kind on it; the
    // legacy raw-throw instanceof is preserved as a fallback so a caller that
    // constructs preflight input through a different path still classifies.
    const kind: PreflightDiagnostic['kind'] = error instanceof CompileError && error.kind === 'budget_syntax_invalid'
      ? 'budget_syntax_invalid'
      : error instanceof CompileError && NAMED_GATE_FAILURE_KINDS.includes(error.kind as NamedGateFailureKind)
        ? error.kind as NamedGateFailureKind
      : error instanceof BudgetSyntaxError
        ? 'budget_syntax_invalid'
        : 'invalid_spec';
    return {
      ok: false,
      gates: [],
      resolutions: [],
      diagnostics: [{
        severity: 'refusal',
        kind,
        message: `Relayflow spec is invalid: ${errors.join('; ')}`,
        errors,
      }],
    };
  }
  const diagnostics: PreflightDiagnostic[] = [];
  const cliResolutionDiagnostics: PreflightDiagnostic[] = [];
  const resolutions: CliResolution[] = [];
  const resolutionByStep = new Map<string, CliResolution>();

  // A pure fact about the compiled snapshot, collected before anything that
  // can return early. An unresolved CLI, an unknown model or a bad scope all
  // refuse below without probing, and the author should still be told that the
  // permissions they declared on the same file are not enforced.
  diagnostics.push(...permissionsDiagnostics(compiled));
  diagnostics.push(...scopeDiagnostics(compiled, options));
  for (const server of new Set(options.mcpServers ?? [])) {
    if (options.mcp !== undefined && Object.hasOwn(options.mcp, server)) continue;
    diagnostics.push({ severity: 'refusal', kind: 'mcp_undeclared_server', server,
      message: `MCP server "${server}" is not declared in the nearest flows.json mcp map.` });
  }
  // Resolve the complete flow before touching any environment fact. A later
  // statically unresolved CLI makes the whole submission impossible, so no
  // earlier command, provider/model, or trigger probe may run first.
  for (const step of compiled.steps) {
    if (step.type === 'deterministic') continue;
    if (step.type === 'agent' && helperCall(step) !== undefined) continue;
    const resolution = resolveCli(step, compiled, options.projectCli);
    if (resolution === undefined) {
      cliResolutionDiagnostics.push({
        severity: 'refusal',
        kind: 'cli_unresolved',
        stepId: step.id,
        message: unresolvedCliMessage(step.id, options),
      });
    } else {
      resolutions.push(resolution);
      resolutionByStep.set(step.id, resolution);
    }
  }
  diagnostics.push(...cliResolutionDiagnostics);
  if (cliResolutionDiagnostics.length > 0) {
    return { ok: false, gates: compiled.steps.map(inspectStepGate), resolutions, diagnostics };
  }
  diagnostics.push(...unknownModelDiagnostics(compiled, options, resolutionByStep));
  diagnostics.push(...budgetDiagnostics(
    compiled,
    new Map(resolutions.map(resolution => [resolution.stepId, {
      cli: resolution.cli,
      ...(resolution.model === undefined ? {} : { model: resolution.model }),
    }])),
  ));
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'refusal')) {
    return { ok: false, gates: compiled.steps.map(inspectStepGate), resolutions, diagnostics };
  }

  return { ok: true, gates: compiled.steps.map(inspectStepGate), resolutions, diagnostics, compiled };
}

function preflightSync(flow: unknown, options: PreflightOptions): PreflightResult {
  const { compiled, ...result } = resolvePreflight(flow, options);
  if (!result.ok || compiled === undefined) return result;
  const { diagnostics, resolutions } = result;
  const resolutionByStep = new Map(resolutions.map(resolution => [resolution.stepId, resolution]));
  const cliProbeResults = options.probeCache ?? new Map<string, CliProbeOutcome>();

  for (const step of compiled.steps) {
    probeNamedGate(step, options.probes, diagnostics);
    warnOnVacuousGate(step, diagnostics);
    warnOnUnprovableEffects(step, options.probes, diagnostics);
    if (step.type === 'deterministic') continue;
    const helper = step.type === 'agent' ? helperCall(step) : undefined;
    if (helper !== undefined) {
      try {
        if (options.probes.helper === undefined) {
          diagnostics.push({ severity: 'warning', kind: 'unprovable_effects', stepId: step.id,
            message: `${helper.provider} helper requires a relayfile mount and an SDK agent worker.` });
        } else if (!options.probes.helper(helper.provider)) {
          diagnostics.push({ severity: 'refusal', kind: 'helper_mount_required', stepId: step.id,
            message: `${helper.provider} helper requires a relayfile mount.` });
        }
      } catch {
        diagnostics.push({ severity: 'refusal', kind: 'probe_failed', stepId: step.id,
          message: `${helper.provider} helper mount could not be checked.` });
      }
      continue;
    }
    const resolution = resolutionByStep.get(step.id)!;
    probeResolvedCli(resolution, options.probes, cliProbeResults, diagnostics,
      step.type === 'agent' && communicationInstruction(step.instruction) !== undefined);
  }

  for (const trigger of compiled.triggers ?? []) {
    probeTrigger(trigger, options.probes, diagnostics);
  }

  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'refusal'),
    gates: compiled.steps.map(inspectStepGate),
    resolutions,
    diagnostics,
  };
}

/**
 * Compile author-declared `workspace:` / `tools.fs:` grants against the nearest
 * relayfile mount manifest. The compiler is pure; only mount discovery reads a
 * fact about the filesystem. Missing manifest means no known mounts — a grant
 * still parses but refuses as `mount_unknown` in that case.
 */
function scopeDiagnostics(flow: FlowSpec, options: ResolutionOptions): PreflightRefusal[] {
  const workspace = flow.workspace;
  const toolsFs = flow.tools?.fs;
  if (workspace === undefined && toolsFs === undefined) return [];
  const input: ScopeInput = {
    ...(workspace === undefined ? {} : { workspace }),
    ...(toolsFs === undefined ? {} : { tools: { fs: toolsFs } }),
  };
  let mounts: MountRegistry | undefined;
  if (options.projectSearchStart !== undefined) {
    try { mounts = readMountRegistry(options.projectSearchStart); }
    catch { mounts = {}; /* fail closed — unreadable manifest treats every mount as unknown */ }
  }
  return compileScopes(input, mounts).diagnostics.map(refusal => ({
    severity: 'refusal',
    kind: refusal.kind,
    message: refusal.message,
    ...(refusal.stepId === undefined ? {} : { stepId: refusal.stepId }),
  }));
}

/** Pure authoring validation: no executable, command, trigger, or daemon probe. */
function unknownModelDiagnostics(
  flow: FlowSpec,
  options: ResolutionOptions,
  resolutionByStep: ReadonlyMap<string, CliResolution> = new Map(),
): PreflightRefusal[] {
  const diagnostics: PreflightRefusal[] = [];
  // model_unknown is a governance check: it exists to enforce a project's
  // registry-declared allowlist. When no flows.json is found, `check.ts` sends
  // `models: []` with `modelRegistryPath: undefined` — an empty list not
  // because the project forbids everything, but because no policy exists.
  // Refusing an inline `agents: { drafter: { cli, model } }` declaration in
  // that state forces every self-contained example flow to ship a second file.
  // A real allowlist (even an empty one from a found flows.json) still
  // enforces; that state is signalled by modelRegistryPath.
  const enforceRegistry = options.modelRegistryPath !== undefined;

  // Named declarations remain in the normalized authoring object until this
  // boundary so even unused or step-shadowed models are checked. toKernelSpec
  // erases the map and selector only after this pass has had a chance to fail.
  for (const [agent, declaration] of Object.entries(flow.agents ?? {})) {
    if (isKnownModel(declaration.model, options.models)) continue;
    if (!enforceRegistry) continue;
    diagnostics.push({
      severity: 'refusal',
      kind: 'model_unknown',
      agent,
      cli: declaration.cli,
      model: declaration.model,
      message: unknownNamedAgentModelMessage(agent, declaration.cli, declaration.model, options.modelRegistryPath),
    });
  }

  for (const step of flow.steps) {
    if (step.type === 'deterministic') continue;
    const resolution = resolutionByStep.get(step.id);
    // Selected named declarations were checked once above, including unused
    // declarations. Other sources are step declarations or adapter defaults.
    if (resolution?.modelSource === 'named') continue;
    const model = resolution?.model ?? step.model;
    if (model === undefined || isKnownModel(model, options.models)) continue;
    if (!enforceRegistry) continue;
    diagnostics.push({
      severity: 'refusal',
      kind: 'model_unknown',
      stepId: step.id,
      ...(resolution === undefined ? {} : { cli: resolution.cli }),
      model,
      message: unknownModelMessage(
        step.id, model, resolution?.cli, options.modelRegistryPath, resolution?.modelSource,
      ),
    });
  }

  return diagnostics;
}

function unknownNamedAgentModelMessage(
  agent: string,
  cli: string,
  model: string,
  registryPath: string | undefined,
): string {
  const source = registryPath === undefined
    ? 'the nearest project config (no model registry was found)'
    : `project model registry "${registryPath}"`;
  return `Named agent "${agent}" declares model "${model}" for CLI "${cli}", but it is not listed in ${source}; add the exact model only after verifying that project is allowed to use it.`;
}

function isKnownModel(model: string, models: readonly string[] | undefined): boolean {
  return models?.includes(model) === true;
}

/**
 * Attribute an effective model to where its value actually came from. Only a
 * `step` value was written on the step; saying "declares" about an adapter
 * default sends the reader looking for a `model:` key that is not there.
 */
function describeEffectiveModel(
  stepId: string,
  model: string,
  cli: string,
  modelSource: CliModelSource | undefined,
): string {
  if (modelSource === 'adapter') {
    return `Step "${stepId}" declares no model; the default for CLI "${cli}" is "${model}"`;
  }
  if (modelSource === 'named') {
    return `Step "${stepId}" uses model "${model}" from its named agent for CLI "${cli}"`;
  }
  return `Step "${stepId}" declares model "${model}" for CLI "${cli}"`;
}

function unknownModelMessage(
  stepId: string,
  model: string,
  cli: string | undefined,
  registryPath: string | undefined,
  modelSource: CliModelSource | undefined,
): string {
  const source = registryPath === undefined
    ? 'the nearest project config (no model registry was found)'
    : `project model registry "${registryPath}"`;
  if (modelSource === 'adapter' && cli !== undefined) {
    // Registry policy still governs a default — it is the model that will run
    // — but the remedy has to name the value the author never typed, and the
    // second way out: declaring a model the registry already allows.
    const add = registryPath === undefined
      ? 'add the exact model'
      : `add the exact model to "models" in "${registryPath}"`;
    return `${describeEffectiveModel(stepId, model, cli, modelSource)}, which is not listed in ${source}; `
      + `${add} only after verifying that project is allowed to use it, or declare an allowed model on the step.`;
  }
  const cliContext = cli === undefined ? '' : ` for CLI "${cli}"`;
  return `Step "${stepId}" declares model "${model}"${cliContext}, but it is not listed in ${source}; add the exact model only after verifying that project is allowed to use it.`;
}

function unresolvedCliMessage(stepId: string, options: ResolutionOptions): string {
  const context = options.projectConfigPath !== undefined
    ? ` Nearest project config "${options.projectConfigPath}" declares no cli; outer configs are shadowed.`
    : options.projectSearchStart !== undefined
      ? ` No flows.json was found from "${options.projectSearchStart}" to the filesystem root.`
      : '';
  return `Step "${stepId}" has no CLI at step, flow, or project level.${context}`;
}

function resolveCli(
  step: Extract<StepSpec, { type: 'llm' | 'agent' }>,
  flow: FlowSpec,
  projectCli: string | undefined,
): CliResolution | undefined {
  const named = step.type === 'agent' && step.agent !== undefined
    ? flow.agents?.[step.agent]
    : undefined;
  const resolved = (cli: string, source: CliResolutionSource): CliResolution => {
    const effectiveModel = resolveCliModelSelection(cli, { step: step.model, named: named?.model });
    return { stepId: step.id, cli, source,
      ...(effectiveModel.model === undefined ? {} : { model: effectiveModel.model }),
      ...(effectiveModel.source === undefined ? {} : { modelSource: effectiveModel.source }) };
  };
  if (step.cli !== undefined) return resolved(step.cli, 'step');
  if (named !== undefined) return resolved(named.cli, 'named');
  if (flow.cli !== undefined) return resolved(flow.cli, 'flow');
  if (projectCli !== undefined) return resolved(projectCli, 'project');
  return undefined;
}

export function cliProbeKey(resolution: CliResolution, managed = false): string {
  return JSON.stringify([resolution.cli, resolution.source, resolution.model ?? null, managed]);
}

function probeResolvedCli(
  resolution: CliResolution,
  probes: PreflightProbes,
  cache: Map<string, CliProbeOutcome>,
  diagnostics: PreflightDiagnostic[],
  managed = false,
): void {
  // Source is load-bearing: the same relative CLI string resolves from the
  // flow directory for step/named/flow declarations and the config directory for
  // project declarations.
  // Model is part of the key: the same CLI probed with two different models
  // is two different questions, and caching on the CLI alone would let a
  // model that the CLI cannot resolve inherit an earlier model's pass.
  const cacheKey = cliProbeKey(resolution, managed);
  let outcome = cache.get(cacheKey);
  if (outcome === undefined) {
    try {
      outcome = { result: managed
        ? probes.cli(resolution.cli, resolution.source, resolution.model, 'managed')
        : probes.cli(resolution.cli, resolution.source, resolution.model) };
    } catch (error) {
      const detail = error instanceof CliProbeError ? error.detail : undefined;
      outcome = { failure: detail ?? null };
    }
    cache.set(cacheKey, outcome);
  }
  if ('failure' in outcome) {
    const detail = outcome.failure ?? undefined;
    diagnostics.push({
      severity: 'refusal',
      kind: 'probe_failed',
      stepId: resolution.stepId,
      cli: resolution.cli,
      ...(detail !== undefined ? { detail } : {}),
      message: probeFailedMessage(resolution, detail),
    });
    return;
  }
  const { result } = outcome;
  if (!result.exists) {
    diagnostics.push({
      severity: 'refusal',
      kind: 'cli_missing',
      stepId: resolution.stepId,
      cli: resolution.cli,
      message: `Step "${resolution.stepId}" declares CLI "${resolution.cli}", but it does not resolve as an executable.`,
    });
  } else if (result.supported === false) {
    diagnostics.push({
      severity: 'refusal',
      kind: 'cli_unsupported',
      stepId: resolution.stepId,
      cli: resolution.cli,
      message: `Step "${resolution.stepId}" declares CLI "${resolution.cli}", but it is neither a supported raw Claude/Codex executable nor a conforming Relayflows wrapper; custom wrappers must identify with the relayflows-agent-cli-v1 contract.`,
    });
  } else if (managed && result.authenticated === 'unverified') {
    diagnostics.push({ severity: 'warning', kind: 'managed_cli_unverified', stepId: resolution.stepId,
      message: `Step "${resolution.stepId}" uses Relay's interactive CLI transport. The executable exists, but authentication${resolution.model ? ' and access to model "' + resolution.model + '"' : ''} could not be verified before startup. The managed session must execute its task and report completion; startup or task failure fails the step.` });
  } else if (result.authenticated !== true) {
    const command = result.authCommand ?? `${resolution.cli} auth status`;
    // Say what the probe reported. A refusal that names only the command turns
    // a transient provider rejection and a genuinely unauthenticated CLI into
    // the same message, and the difference decides whether retrying is
    // correct.
    const exitCode = result.authExitCode === undefined || result.authExitCode === null
      ? ''
      : ` (exit ${result.authExitCode})`;
    const detail = result.authFailureDetail !== undefined && result.authFailureDetail.length > 0
      ? ` It reported: ${result.authFailureDetail}`
      : ' It produced no output, so the reason is unavailable.';
    diagnostics.push({
      severity: 'refusal',
      kind: 'cli_unauthenticated',
      stepId: resolution.stepId,
      cli: resolution.cli,
      message: `Step "${resolution.stepId}" declares CLI "${resolution.cli}", but "${command}" exited non-zero${exitCode}; authenticate it or repair that adapter's authentication probe.${detail}`,
    });
  } else if (resolution.model !== undefined && result.modelAvailable !== true) {
    diagnostics.push({
      severity: 'refusal',
      kind: 'model_unavailable',
      stepId: resolution.stepId,
      cli: resolution.cli,
      model: resolution.model,
      message: describeEffectiveModel(resolution.stepId, resolution.model, resolution.cli, resolution.modelSource)
        + `, but its model-scoped "${result.modelCommand ?? `${resolution.cli} auth status`}" probe exited non-zero;`
        + ` verify the model name and this credential's access.`,
    });
  }
}

function probeFailedMessage(
  resolution: CliResolution,
  detail?: CliProbeFailureDetail,
): string {
  const prefix = `Could not verify CLI "${resolution.cli}" for step "${resolution.stepId}"`;
  if (detail === undefined) return `${prefix}.`;
  if (detail === 'spawn_failed') return `${prefix}: the probe process could not be started.`;
  if (detail.startsWith('signal:')) {
    return `${prefix}: the probe was terminated by signal "${detail.slice('signal:'.length)}".`;
  }
  return `${prefix}: the probe timed out after ${detail.slice('timeout:'.length)}.`;
}

function probeTrigger(
  trigger: TriggerSpec,
  probes: PreflightProbes,
  diagnostics: PreflightDiagnostic[],
): void {
  let registered: boolean;
  try {
    registered = probes.executor(trigger);
  } catch {
    diagnostics.push({
      severity: 'refusal',
      kind: 'probe_failed',
      triggerId: trigger.id,
      executor: trigger.executor,
      message: `Could not verify executor "${trigger.executor}" for trigger "${trigger.id}".`,
    });
    return;
  }
  if (!registered) {
    diagnostics.push({
      severity: 'refusal',
      kind: 'no_executor',
      triggerId: trigger.id,
      executor: trigger.executor,
      message: `Trigger "${trigger.id}" has no registered executor "${trigger.executor}".`,
    });
  }
}

/**
 * A deterministic step is never silently accepted. An unresolved bare command
 * may still be a shell builtin, function, or assignment, so it warns. A command
 * containing `/` names a path rather than relying on shell resolution, so a
 * failed existence probe refuses the flow.
 */
/**
 * A declared `json_schema` gate that accepts every output is legal and stays
 * legal — but it is indistinguishable in the gate plan from one that judges
 * something, which is exactly the confusion AGENTS.md's "never edit a gate that
 * judges your own work" rail exists to prevent.
 */
function warnOnVacuousGate(step: StepSpec, diagnostics: PreflightDiagnostic[]): void {
  if (step.verification?.type !== 'json_schema') return;
  if (!acceptsAnyOutput(step.verification.schema)) return;
  diagnostics.push({
    severity: 'warning',
    kind: 'vacuous_gate',
    stepId: step.id,
    message: `Step "${step.id}" declares a json_schema gate that accepts every possible output, so it judges nothing.`,
  });
}

function warnOnUnprovableEffects(
  step: StepSpec,
  probes: PreflightProbes,
  diagnostics: PreflightDiagnostic[],
): void {
  if (step.type !== 'deterministic') return;
  const first = firstCommandWordDetailed(step.command);
  if (first === undefined) {
    diagnostics.push({
      severity: 'warning',
      kind: 'command_unprovable',
      stepId: step.id,
      message: `Step "${step.id}" has no command word to check, so nothing about it can be proven before execution.`,
    });
    return;
  }
  if (first.shell) {
    // `set -e`, `if …`, `cd …`: the shell supplies these, so there is nothing
    // to resolve on PATH — and nothing to refuse. What they go on to run is
    // the rest of the script, whose effects preflight never claimed to prove.
    diagnostics.push({
      severity: 'warning',
      kind: 'unprovable_effects',
      stepId: step.id,
      message: `Step "${step.id}" starts with the shell ${first.kind} "${first.word}", whose effects cannot be proven before execution.`,
    });
    return;
  }
  const binary = first.word;
  let exists: boolean;
  try {
    exists = probes.command(binary);
  } catch {
    diagnostics.push({
      severity: 'warning',
      kind: 'command_unprovable',
      stepId: step.id,
      message: `Step "${step.id}" command "${binary}" could not be probed, so its presence is unproven before execution.`,
    });
    return;
  }
  diagnostics.push(exists
    ? {
      severity: 'warning',
      kind: 'unprovable_effects',
      stepId: step.id,
      message: `Step "${step.id}" command "${binary}" resolves, but its effects cannot be proven before execution.`,
    }
    : binary.includes('/')
      ? {
        severity: 'refusal',
        kind: 'command_missing',
        stepId: step.id,
        message: `Step "${step.id}" command path "${binary}" does not exist.`,
      }
    : {
      severity: 'warning',
      kind: 'command_unresolved',
      stepId: step.id,
      message: `Step "${step.id}" command "${binary}" does not resolve as an executable; it runs only if the shell supplies it.`,
    });
}

/** POSIX special builtins and reserved words: the shell supplies them, PATH never does. */
const SHELL_SPECIAL_BUILTINS = new Set([
  '.', ':', 'break', 'continue', 'eval', 'exec', 'exit', 'export', 'readonly', 'return', 'set',
  'shift', 'times', 'trap', 'unset',
  // Regular builtins that no sane flow ships as an executable.
  'cd', 'alias', 'unalias', 'local', 'source', 'wait', 'umask', 'ulimit', 'read', 'command', 'type',
]);
const SHELL_RESERVED_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  'function', 'select', 'time', '{', '}', '(', ')', '!', '[[', ']]',
]);

interface FirstCommandWord {
  word: string;
  /** True when the shell itself provides the word, so there is nothing to look up. */
  shell: boolean;
  kind: 'command' | 'builtin' | 'reserved word';
}

function firstCommandWord(command: string): string | undefined {
  return firstCommandWordDetailed(command)?.word;
}

function firstCommandWordDetailed(command: string): FirstCommandWord | undefined {
  // A lightweight lexical pass — not a shell parser. It walks the script once,
  // quote-aware: comments outside quotes are dropped, quoted text is opaque
  // (an apostrophe in `# don't` or a `<<EOF` inside `VALUE='<<EOF'` is data),
  // and the script is split into simple-command segments on unquoted `;`,
  // `&&`, `||`, `|` and newlines. The first segment that is not only
  // assignments and redirections holds the command word (cloud#3777).
  //
  // A heredoc opener or a quote left open at the end of the script means the
  // following text is data the shell never executes; if no command word was
  // found before it, the answer is "cannot be proven", not "missing".
  const segments = lexSimpleCommands(command);
  if (segments === undefined) return undefined;
  for (const segment of segments) {
    const remainder = stripShellPrefixes(segment);
    if (remainder === '') continue;
    const match = remainder.match(/^(?:"([^"]*)"|'([^']*)'|([^\s]+))/);
    const word = match?.[1] ?? match?.[2] ?? match?.[3];
    if (word === undefined || word === '') continue;
    if (SHELL_SPECIAL_BUILTINS.has(word)) return { word, shell: true, kind: 'builtin' };
    if (SHELL_RESERVED_WORDS.has(word)) return { word, shell: true, kind: 'reserved word' };
    return { word, shell: false, kind: 'command' };
  }
  return undefined;
}

/**
 * Split a script into simple-command segments, comments removed, quotes kept.
 * Returns undefined when a heredoc or an unclosed quote begins before any
 * segment could be completed past it — the rest is data.
 */
function lexSimpleCommands(script: string): string[] | undefined {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  let heredoc = false;
  const flush = (): void => {
    if (current.trim() !== '') segments.push(current.trim());
    current = '';
  };
  for (let i = 0; i < script.length; i += 1) {
    const char = script[i]!;
    if (quote !== undefined) {
      current += char;
      if (char === '\\' && quote === '"' && i + 1 < script.length) { current += script[++i]; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\\' && i + 1 < script.length) { current += char + script[++i]; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '#' && (current === '' || /\s$/.test(current))) {
      // Comment to end of line, outside quotes only.
      while (i + 1 < script.length && script[i + 1] !== '\n') i += 1;
      continue;
    }
    if (char === '<' && script[i + 1] === '<') {
      // A heredoc: everything after this line is its body, so the current
      // segment is the last one the shell reads as a command.
      heredoc = true;
      while (i + 1 < script.length && script[i + 1] !== '\n') i += 1;
      flush();
      break;
    }
    if (char === '\n' || char === ';') { flush(); continue; }
    if ((char === '&' && script[i + 1] === '&') || (char === '|' && script[i + 1] === '|')) { flush(); i += 1; continue; }
    if (char === '|') { flush(); continue; }
    if (char === '&') {
      // `&` is a boundary only as a background operator. In `2>&1`, `>&2`,
      // `<&0` and `&>file` it is part of a redirection: the `&` after a `>`
      // or `<` (with an optional fd number before that), or the `&` that
      // starts `&>`.
      const afterRedirect = /[<>]\s*$/.test(current);
      if (afterRedirect || script[i + 1] === '>') { current += char; continue; }
      flush();
      continue;
    }
    current += char;
  }
  if (!heredoc && quote === undefined) flush();
  // Whatever was accumulated when a heredoc or an open quote cut the scan is
  // not a complete command; only the segments closed before it count.
  if (segments.length === 0 && (heredoc || quote !== undefined)) return undefined;
  return segments;
}

function stripShellPrefixes(segment: string): string {
  // Skip the shell prefixes that can legally precede the command word.
  //
  // Review caught this on PR #47: the new path-like refusal keys on the first
  // word containing a slash, and `TMPDIR=/tmp printf ok`, `>/tmp/out echo hi`
  // and `PATH=/usr/bin:$PATH mkdir x` all have one — but none of them names a
  // path to execute. All three are valid and were being refused outright,
  // which is exactly the "refusing would reject valid flows" failure the warn
  // behaviour exists to avoid.
  //
  // An assignment is NAME=value with a shell-legal name and an opaque quoted
  // value; a redirection starts with < or > (optionally with a leading fd
  // number). Neither is the command. Segments never contain `;`/newlines.
  let rest = segment;
  for (;;) {
    const prefix = rest.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]*)|(?:[0-9]*[<>]{1,2}&?|&>>?)\s*[^\s]+)(?:\s+|$)/);
    if (prefix === null) break;
    rest = rest.slice(prefix[0].length);
  }
  return rest.trim();
}

function probeNamedGate(step: StepSpec, probes: PreflightProbes, diagnostics: PreflightDiagnostic[]): void {
  const gate = step.verification;
  if (!isNamedGate(gate)) return;
  const commands = ['node', ...(gate.type === 'word_count_bounds' ? ['wc'] : [])];
  if (gate.type === 'subprocess_gate') commands.push(firstCommandWord(gate.command) ?? '');
  for (const command of commands) {
    let exists = false;
    try { exists = command !== '' && probes.command(command); } catch { /* Fail closed on an unprovable gate. */ }
    if (exists) continue;
    diagnostics.push({ severity: 'refusal', kind: 'gate_command_missing', stepId: step.id,
      message: `Step "${step.id}" ${gate.type} command "${command}" does not resolve as an executable.` });
  }
}

export { preflightHelpers } from './helper-preflight.js';

/** Authored memory probes run before invoking the body or contacting the journal. */
export async function preflightMemory(
  probe: () => Promise<void>,
): Promise<PreflightRefusal | undefined> {
  try {
    await probe();
    return undefined;
  } catch {
    return {
      severity: 'refusal',
      kind: 'memory_unreachable',
      message: 'Script memory requires the ai-hist Node SDK and a readable SQLite database at AI_HIST_DB (or defaultDbPath()). Run ai-hist sync first.',
    };
  }
}
