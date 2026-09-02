import type { FlowSpec, StepSpec, TriggerSpec } from './spec.js';
import { inspectStepGate, type StepGateInspection } from './gate-contract.js';
import type {
  PreflightFailureKind,
  PreflightWarningKind,
} from './failure-kinds.js';

export type CliResolutionSource = 'step' | 'flow' | 'project';

export interface CliResolution {
  stepId: string;
  cli: string;
  source: CliResolutionSource;
  /** Model the step declared, probed together with the CLI. */
  model?: string;
}

export interface CliProbeResult {
  exists: boolean;
  authenticated: boolean;
}

export type CliProbeFailureDetail =
  | 'spawn_failed'
  | 'timeout:5000ms'
  | 'timeout:10000ms'
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
  projectCli?: string;
  projectConfigPath?: string;
  projectSearchStart?: string;
  probes: PreflightProbes;
}

export interface PreflightRefusal {
  severity: 'refusal';
  kind: PreflightFailureKind;
  message: string;
  stepId?: string;
  cli?: string;
  triggerId?: string;
  executor?: string;
  detail?: CliProbeFailureDetail;
}

export interface PreflightWarning {
  severity: 'warning';
  kind: PreflightWarningKind;
  message: string;
  stepId?: string;
}

export type PreflightDiagnostic = PreflightRefusal | PreflightWarning;

export interface PreflightResult {
  ok: boolean;
  gates: StepGateInspection[];
  resolutions: CliResolution[];
  diagnostics: PreflightDiagnostic[];
}

export function preflight(flow: FlowSpec, options: PreflightOptions): PreflightResult {
  const diagnostics: PreflightDiagnostic[] = [];
  const resolutions: CliResolution[] = [];
  const cliProbeResults = new Map<string, CliProbeOutcome>();

  for (const step of flow.steps) {
    warnOnUnprovableEffects(step, options.probes, diagnostics);
    if (step.type === 'deterministic') continue;

    const resolution = resolveCli(step, flow, options.projectCli);
    if (resolution === undefined) {
      diagnostics.push({
        severity: 'refusal',
        kind: 'cli_unresolved',
        stepId: step.id,
        message: unresolvedCliMessage(step.id, options),
      });
      continue;
    }
    resolutions.push(resolution);
    probeResolvedCli(resolution, options.probes, cliProbeResults, diagnostics);
  }

  for (const trigger of flow.triggers ?? []) {
    probeTrigger(trigger, options.probes, diagnostics);
  }

  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'refusal'),
    gates: flow.steps.map(inspectStepGate),
    resolutions,
    diagnostics,
  };
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
  // Model is a step-level declaration only — there is deliberately no flow or
  // project default. A CLI inheriting a model from two levels up is the
  // ambient-state problem this field exists to remove.
  const model = step.model !== undefined ? { model: step.model } : {};
  if (step.cli !== undefined) return { stepId: step.id, cli: step.cli, source: 'step', ...model };
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
  // flow directory for step/flow declarations and the config directory for
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
  } else if (!result.authenticated) {
    diagnostics.push({
      severity: 'refusal',
      kind: 'cli_unauthenticated',
      stepId: resolution.stepId,
      cli: resolution.cli,
      message: `Step "${resolution.stepId}" declares CLI "${resolution.cli}", but "${resolution.cli} auth status" exited non-zero; authenticate it or implement that probe to return exit 0 when authenticated.`,
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
