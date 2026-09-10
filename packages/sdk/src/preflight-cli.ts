import { modelNameError } from './model-name.js';
import { CliProbeError } from './preflight-probe-error.js';
import type { FlowSpec, StepSpec, NamedAgentSpec } from './spec.js';
import { type CliProbeResult, type CliProbeFailureDetail, type CliResolution, type PreflightOptions, type PreflightProbes, type PreflightDiagnostic, type PreflightRefusal, type PreflightResult } from './preflight.js';

export type CliProbeOutcome =
  | { result: CliProbeResult }
  | { failure: CliProbeFailureDetail | null };

/** Pure authoring validation: no executable, command, trigger, or daemon probe. */
export function unknownModelDiagnostics(
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
  diagnostics.push(...unknownAgentModels(flow.agents ?? {}, options));

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

export function unresolvedCliMessage(stepId: string, options: PreflightOptions): string {
  const context = options.projectConfigPath !== undefined
    ? ` Nearest project config "${options.projectConfigPath}" declares no cli; outer configs are shadowed.`
    : options.projectSearchStart !== undefined
      ? ` No flows.json was found from "${options.projectSearchStart}" to the filesystem root.`
      : '';
  return `Step "${stepId}" has no CLI at step, flow, or project level.${context}`;
}

export function resolveCli(
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

export function probeResolvedCli(
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


/** Header data has already been snapshotted and validated by the surface. */
export function preflightAgentDeclarations(
  agents: Readonly<Record<string, Readonly<NamedAgentSpec>>>,
  options: PreflightOptions,
): PreflightResult {
  const diagnostics: PreflightDiagnostic[] = [];
  const resolutions: CliResolution[] = [];
  // The surface validates declaration shape, while the SDK also owns model
  // syntax. Check it before policy or any CLI probe, just as compileSpec does.
  for (const [agent, declaration] of Object.entries(agents)) {
    const problem = modelNameError(declaration.model);
    if (problem !== undefined) {
      const error = `spec.agents.${agent}.model: ${problem}`;
      diagnostics.push({ severity: 'refusal', kind: 'invalid_spec', agent,
        message: `Relayflow spec is invalid: ${error}`, errors: [error] });
    }
  }
  if (diagnostics.length > 0) return { ok: false, gates: [], resolutions, diagnostics };
  diagnostics.push(...unknownAgentModels(agents, options));
  for (const [agent, declaration] of Object.entries(agents)) {
    resolutions.push({ stepId: agent, source: 'named', ...declaration });
  }
  if (diagnostics.length === 0) {
    const cache = new Map<string, CliProbeOutcome>();
    for (const resolution of resolutions) {
      probeResolvedCli(resolution, options.probes, cache, diagnostics);
    }
  }
  return { ok: !diagnostics.some(d => d.severity === 'refusal'), gates: [], resolutions, diagnostics };
}

function unknownAgentModels(
  agents: Readonly<Record<string, Readonly<NamedAgentSpec>>>,
  options: PreflightOptions,
): PreflightRefusal[] {
  if (options.modelRegistryPath === undefined) return [];
  return Object.entries(agents).flatMap(([agent, declaration]) =>
    isKnownModel(declaration.model, options.models) ? [] : [{
      severity: 'refusal', kind: 'model_unknown', agent,
      cli: declaration.cli, model: declaration.model,
      message: unknownNamedAgentModelMessage(agent, declaration.cli, declaration.model, options.modelRegistryPath),
    }]);
}
