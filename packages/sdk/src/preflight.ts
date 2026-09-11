import type { FlowSpec, StepSpec, TriggerSpec, McpServerConfig } from './spec.js';
import { McpError, openMcpSession, type McpDiagnostic } from './mcp-client.js';
import { BudgetSyntaxError } from './budget.js';
import { budgetDiagnostics } from './budget-preflight.js';
import type { TriggerSource } from '@relayflows/surface';
import { acceptsAnyOutput, inspectStepGate, type StepGateInspection } from './gate-contract.js';
import { compileSpec, CompileError } from './compile.js';
import type {
  PreflightFailureKind,
  PreflightWarningKind,
} from './failure-kinds.js';

export type CliResolutionSource = 'step' | 'named' | 'flow' | 'project';

export interface CliResolution {
  stepId: string;
  cli: string;
  source: CliResolutionSource;
  /** Model the step or selected named agent declared, probed with the CLI. */
  model?: string;
}

export interface CliProbeResult {
  exists: boolean;
  authenticated: boolean;
  /** False when a custom executable did not identify as a wrapper adapter. */
  supported?: boolean;
  /** Exact declared model passed the CLI's model-scoped readiness probe. */
  modelAvailable?: boolean;
  authCommand?: string;
  modelCommand?: string;
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

type CliProbeOutcome =
  | { result: CliProbeResult }
  | { failure: CliProbeFailureDetail | null };

/**
 * Environment facts are injected; this module performs no I/O. A probe may
 * throw when its fact cannot be collected. Preflight catches that boundary and
 * emits `probe_failed` (or `command_unprovable` for a deterministic command).
 */
export interface PreflightProbes {
  /**
   * Resolve relative paths against the file implied by `source`, then probe
   * `auth status`. When the step declared a `model`, the probe runs with that
   * model in scope, so readiness answers "can this CLI use THIS model" rather
   * than the weaker "is this CLI authenticated at all".
   */
  cli(cli: string, source: CliResolutionSource, model?: string): CliProbeResult;
  executor(trigger: TriggerSpec): boolean;
  command(binary: string): boolean;
}

export interface PreflightOptions {
  /** Validated tools.mcp header and nearest flows.json connections. */
  mcpServers?: readonly string[];
  mcp?: Readonly<Record<string, McpServerConfig>>;
  projectCli?: string;
  projectConfigPath?: string;
  projectSearchStart?: string;
  /** Exact, project-owned model allowlist from the nearest flows.json. */
  models?: readonly string[];
  modelRegistryPath?: string;
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
  mcpTools?: Readonly<Record<string, readonly string[]>>;
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
  return [...new Set(triggers.map(trigger => trigger.name))]
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
  return probeMcp(result, options);
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

function preflightSync(flow: unknown, options: PreflightOptions): PreflightResult {
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
  const resolutions: CliResolution[] = [];
  const resolutionByStep = new Map<string, CliResolution>();
  const cliProbeResults = new Map<string, CliProbeOutcome>();

  diagnostics.push(...unknownModelDiagnostics(compiled, options));
  for (const server of new Set(options.mcpServers ?? [])) {
    if (options.mcp !== undefined && Object.hasOwn(options.mcp, server)) continue;
    diagnostics.push({ severity: 'refusal', kind: 'mcp_undeclared_server', server,
      message: `MCP server "${server}" is not declared in the nearest flows.json mcp map.` });
  }
  diagnostics.push(...budgetDiagnostics(compiled));
  // Resolve the complete flow before touching any environment fact. A later
  // statically unresolved CLI makes the whole submission impossible, so no
  // earlier command, provider/model, or trigger probe may run first.
  for (const step of compiled.steps) {
    if (step.type === 'deterministic') continue;
    const resolution = resolveCli(step, compiled, options.projectCli);
    if (resolution === undefined) {
      diagnostics.push({
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
  if (diagnostics.length > 0) {
    return { ok: false, gates: compiled.steps.map(inspectStepGate), resolutions, diagnostics };
  }

  for (const step of compiled.steps) {
    warnOnVacuousGate(step, diagnostics);
    warnOnUnprovableEffects(step, options.probes, diagnostics);
    if (step.type === 'deterministic') continue;
    const resolution = resolutionByStep.get(step.id)!;
    probeResolvedCli(resolution, options.probes, cliProbeResults, diagnostics);
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

/** Pure authoring validation: no executable, command, trigger, or daemon probe. */
function unknownModelDiagnostics(
  flow: FlowSpec,
  options: PreflightOptions,
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
    if (step.type === 'deterministic' || step.model === undefined) continue;
    if (isKnownModel(step.model, options.models)) continue;
    const resolution = resolveCli(step, flow, options.projectCli);
    diagnostics.push({
      severity: 'refusal',
      kind: 'model_unknown',
      stepId: step.id,
      ...(resolution === undefined ? {} : { cli: resolution.cli }),
      model: step.model,
      message: unknownModelMessage(step.id, step.model, resolution?.cli, options.modelRegistryPath),
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

function unknownModelMessage(
  stepId: string,
  model: string,
  cli: string | undefined,
  registryPath: string | undefined,
): string {
  const source = registryPath === undefined
    ? 'the nearest project config (no model registry was found)'
    : `project model registry "${registryPath}"`;
  const cliContext = cli === undefined ? '' : ` for CLI "${cli}"`;
  return `Step "${stepId}" declares model "${model}"${cliContext}, but it is not listed in ${source}; add the exact model only after verifying that project is allowed to use it.`;
}

function unresolvedCliMessage(stepId: string, options: PreflightOptions): string {
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
  // Model comes only from the step or its explicitly selected declaration.
  // There is deliberately no flow/project or host default.
  const effectiveModel = step.model ?? named?.model;
  const model = effectiveModel !== undefined ? { model: effectiveModel } : {};
  if (step.cli !== undefined) return { stepId: step.id, cli: step.cli, source: 'step', ...model };
  if (named !== undefined) return { stepId: step.id, cli: named.cli, source: 'named', ...model };
  if (flow.cli !== undefined) return { stepId: step.id, cli: flow.cli, source: 'flow', ...model };
  if (projectCli !== undefined) return { stepId: step.id, cli: projectCli, source: 'project', ...model };
  return undefined;
}

function probeResolvedCli(
  resolution: CliResolution,
  probes: PreflightProbes,
  cache: Map<string, CliProbeOutcome>,
  diagnostics: PreflightDiagnostic[],
): void {
  // Source is load-bearing: the same relative CLI string resolves from the
  // flow directory for step/named/flow declarations and the config directory for
  // project declarations.
  // Model is part of the key: the same CLI probed with two different models
  // is two different questions, and caching on the CLI alone would let a
  // model that the CLI cannot resolve inherit an earlier model's pass.
  const cacheKey = JSON.stringify([resolution.cli, resolution.source, resolution.model ?? null]);
  let outcome = cache.get(cacheKey);
  if (outcome === undefined) {
    try {
      outcome = { result: probes.cli(resolution.cli, resolution.source, resolution.model) };
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
  } else if (!result.authenticated) {
    const command = result.authCommand ?? `${resolution.cli} auth status`;
    diagnostics.push({
      severity: 'refusal',
      kind: 'cli_unauthenticated',
      stepId: resolution.stepId,
      cli: resolution.cli,
      message: `Step "${resolution.stepId}" declares CLI "${resolution.cli}", but "${command}" exited non-zero; authenticate it or repair that adapter's authentication probe.`,
    });
  } else if (resolution.model !== undefined && result.modelAvailable !== true) {
    diagnostics.push({
      severity: 'refusal',
      kind: 'model_unavailable',
      stepId: resolution.stepId,
      cli: resolution.cli,
      model: resolution.model,
      message: `Step "${resolution.stepId}" declares model "${resolution.model}" for CLI "${resolution.cli}", but its model-scoped "${result.modelCommand ?? `${resolution.cli} auth status`}" probe exited non-zero; verify the model name and this credential's access.`,
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
  const binary = firstCommandWord(step.command);
  if (binary === undefined) {
    diagnostics.push({
      severity: 'warning',
      kind: 'command_unprovable',
      stepId: step.id,
      message: `Step "${step.id}" has no command word to check, so nothing about it can be proven before execution.`,
    });
    return;
  }
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

function firstCommandWord(command: string): string | undefined {
  // Skip the shell prefixes that can legally precede the command word.
  //
  // Review caught this on PR #47: the new path-like refusal keys on the first
  // word containing a slash, and `TMPDIR=/tmp printf ok`, `>/tmp/out echo hi`
  // and `PATH=/usr/bin:$PATH mkdir x` all have one — but none of them names a
  // path to execute. All three are valid and were being refused outright,
  // which is exactly the "refusing would reject valid flows" failure the warn
  // behaviour exists to avoid.
  //
  // An assignment is NAME=value with a shell-legal name; a redirection starts
  // with < or > (optionally with a leading fd number). Neither is the command.
  let rest = command.trim();
  for (;;) {
    const prefix = rest.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)|[0-9]*[<>]{1,2}\s*[^\s]+)\s+/);
    if (prefix === null) break;
    rest = rest.slice(prefix[0].length);
  }
  const match = rest.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Helper preflight never evaluates the authored body. Dynamic uses are checked at call time. */
export function preflightHelpers(
  definition: { header?: { tools?: { slack?: boolean } }; body?: Function },
  facts: { slackToken?: string; slackMount: boolean; slackMock: boolean },
): PreflightResult {
  const usesSlack = definition.header?.tools?.slack === true
    || (typeof definition.body === 'function'
      && /(?:\.\s*slack\b|\[\s*['"]slack['"]\s*\])/.test(Function.prototype.toString.call(definition.body)));
  const diagnostics: PreflightDiagnostic[] = usesSlack && !facts.slackMock
    && !facts.slackToken?.trim() && !facts.slackMount
    ? [{ severity: 'refusal', kind: 'helper_slack.credential_missing',
        message: 'f.slack requires SLACK_BOT_TOKEN or a relayfile Slack mount.' }]
    : usesSlack && !facts.slackMock && !facts.slackMount
      ? [{ severity: 'refusal', kind: 'helper_slack.mount_required',
          message: 'f.slack direct bot-token transport is not implemented; configure a relayfile Slack mount.' }]
      : [];
  return { ok: diagnostics.length === 0, gates: [], resolutions: [], diagnostics };
}

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
