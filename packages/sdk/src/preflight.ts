import { unknownModelDiagnostics, unresolvedCliMessage, resolveCli, probeResolvedCli, type CliProbeOutcome } from './preflight-cli.js';
import type { FlowSpec, StepSpec, TriggerSpec } from './spec.js';
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

export { CliProbeError } from './preflight-probe-error.js';

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
  /** Exact, project-owned model allowlist from the nearest flows.json. */
  models?: readonly string[];
  modelRegistryPath?: string;
  probes: PreflightProbes;
}

export interface PreflightRefusal {
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
  ok: boolean;
  gates: StepGateInspection[];
  resolutions: CliResolution[];
  diagnostics: PreflightDiagnostic[];
}

export function preflight(flow: FlowSpec, options: PreflightOptions): PreflightResult {
  // Compile before touching any environment fact. `compileSpec` snapshots raw
  // input into inert data, validates it against the closed authoring schema,
  // and lowers `output` sugar into its json_schema gate — so the gate plan
  // below describes what the kernel will actually judge, and no probe or gate
  // inspection ever reads a live accessor. The failure is a named refusal
  // rather than a thrown error (RFC covenant 2), which is the contract main
  // settled for this boundary.
  let compiled: FlowSpec;
  try {
    compiled = compileSpec(flow);
  } catch (error) {
    const errors = error instanceof CompileError
      ? error.errors
      : [error instanceof Error ? error.message : 'spec: expected JSON-compatible data'];
    return {
      ok: false,
      gates: [],
      resolutions: [],
      diagnostics: [{
        severity: 'refusal',
        kind: 'invalid_spec',
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
