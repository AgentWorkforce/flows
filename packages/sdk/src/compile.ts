// The YAML -> spec compiler. Authoring surface in, the kernel's spec dialect
// out (RFC settled decision #5: the composable unit is the spec, not any
// language). Compilation is two mappings:
//
//   compileYaml / compileSpec  — parse + validate (fail-closed) + authoring
//                                defaults, staying in the authoring shape.
//   toKernelSpec               — authoring shape -> the ONE boundary dialect
//                                the kernel parses, journals, and hashes
//                                (snake_case, flat v0 verification, defaults
//                                materialized).
//
// `compileYamlToCanonicalJson` / `specHash` operate on the kernel dialect, so
// sha256(canonical JSON) equals the kernel's `spec_hash`. That claim is
// proven, not asserted: `tests/spec-parity.test.ts` and the kernel's
// `tests/spec_parity.rs` pin both sides to the same `testdata/` fixture.

import { parse as parseYaml } from 'yaml';
import { parseBudget, toKernelBudget } from './budget.js';
import { bindingDependencies } from './input-binding.js';
import { namedGateFailure } from './named-gates.js';
import { lowerNamedGates } from './named-gate-lowering.js';
import type {
  AgentStepSpec,
  DeterministicStepSpec,
  FlowSpec,
  KernelAgentStep,
  KernelRunSpec,
  KernelStepCommon,
  KernelStepSpec,
  KernelTriggerSpec,
  KernelVerificationSpec,
  LlmStepSpec,
  NamedAgentSpec,
  OutputVerificationSpec,
  StepSpec,
  StepType,
  TriggerSpec,
  VerificationSpec,
} from './spec.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import { canonicalize, specHash } from './canonical.js';
import { validateOutputDeclaration } from './output-schema.js';
import { validateSpec, type ValidationResult } from './validate.js';
import { snapshotJsonValue } from './json-value.js';
import { expandYamlHelpers } from './yaml-helpers.js';

export class CompileError extends Error {
  readonly errors: string[];
  /** Optional diagnostic kind for callers that classify refusals (e.g. preflight). */
  readonly kind?: string;
  constructor(errors: string[], kind?: string) {
    super('spec compile failed:\n  - ' + errors.join('\n  - '));
    this.name = 'CompileError';
    this.errors = errors;
    if (kind !== undefined) this.kind = kind;
  }
}

/**
 * Parse the f.run timeout before submitting any command to the kernel.
 *
 * Accepts a positive whole-millisecond `number`, or a duration string of the
 * form `<coefficient><unit>` where unit is `ms` / `s` / `m` — matched by an
 * anchored regex that captures the coefficient first (group 1) and the unit
 * second (group 2), so a future edit cannot silently swap them. Fractional
 * coefficients that resolve to integer milliseconds are accepted; the
 * multiplication is rounded to the nearest integer so `1.1s → 1100`
 * survives float-precision (`1.1 * 1000 = 1100.0000000000002`) rather than
 * being rejected by `isSafeInteger`.
 */
export function parseStepTimeout(timeout: unknown): number {
  const unitToMs: Record<'ms' | 's' | 'm', number> = { ms: 1, s: 1000, m: 60_000 };
  let milliseconds: number;
  if (typeof timeout === 'number') {
    milliseconds = timeout;
  } else if (typeof timeout === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(timeout);
    if (match === null) {
      milliseconds = NaN;
    } else {
      const coefficient = Number(match[1]);
      const unit = match[2] as 'ms' | 's' | 'm';
      // Round to defeat float precision (1.1 * 1000 = 1100.0000000000002).
      // Fractional milliseconds themselves (e.g. `1.5ms`) still round to `2`,
      // which the isSafeInteger check below accepts. Sub-ms precision is not
      // a supported unit — authors expressing "1.5ms" get the closest int.
      milliseconds = Math.round(coefficient * unitToMs[unit]);
    }
  } else {
    milliseconds = NaN;
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new CompileError(['f.run timeout must be a positive whole number of milliseconds or a duration such as "10s" or "5m".'], 'timeout_invalid');
  }
  if (milliseconds > 15 * 60_000) {
    throw new CompileError(['f.run timeout exceeds the maximum of 15 minutes declared in SURFACE.md.'], 'lease_exceeded');
  }
  return milliseconds;
}

/**
 * Compile a YAML string into a validated authoring `FlowSpec`.
 * Throws `CompileError` on a YAML parse error or any validation failure.
 */
export function compileYaml(yaml: string): CompiledFlowSpec {
  const parsed = parseYaml(yaml);
  if (parsed === null || typeof parsed !== 'object') {
    throw new CompileError(['YAML: expected a mapping at the top level']);
  }
  return compileSpec(parsed);
}

/** Kernel-dialect canonical JSON of `compileYaml` (sorted keys, no whitespace). */
export function compileYamlToCanonicalJson(yaml: string): string {
  return canonicalize(toKernelSpec(compileYaml(yaml)));
}

/**
 * Validate a parsed spec object and apply authoring defaults, returning a
 * normalized `FlowSpec`. Throws `CompileError` on validation failure.
 */
export type CompiledFlowSpec = Omit<FlowSpec, 'budget'> & { budget?: import('./spec.js').BudgetSpec };

export function compileSpec(spec: unknown): CompiledFlowSpec {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonValue(spec, 'spec');
    snapshot = expandYamlHelpers(snapshot);
  } catch (error) {
    throw new CompileError([
      error instanceof Error ? error.message : 'spec: expected JSON-compatible data',
    ]);
  }
  if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot) && 'budget' in snapshot && snapshot.budget !== undefined) {
    // parseBudget throws BudgetSyntaxError on any malformed header. Without
    // this wrap, that throw escaped compileSpec's own CompileError contract,
    // so callers (validate, cli/check) that only catch CompileError would
    // surface the budget error as an uncaught exception instead of a
    // diagnostic. Rewrap as CompileError so it flows through the same
    // gate-1 refusal path as every other invalid spec.
    try {
      snapshot = { ...snapshot, budget: parseBudget(snapshot.budget) };
    } catch (error) {
      throw new CompileError(
        [`spec.budget: ${error instanceof Error ? error.message : 'budget_syntax_invalid'}`],
        'budget_syntax_invalid',
      );
    }
  }
  const validation: ValidationResult = validateSpec(snapshot);
  if (!validation.ok) throw new CompileError(validation.errors, namedGateFailure(validation.errors));

  const input = snapshot as CompiledFlowSpec;
  // Preserve named declarations and selectors through authoring normalization.
  // They are resolved exactly once at the kernel boundary, after public
  // preflight has validated every declaration with truthful provenance.
  const steps = input.steps.map(compileStep);
  const flow: CompiledFlowSpec = {
    version: input.version,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.cli !== undefined ? { cli: input.cli } : {}),
    ...(input.agents !== undefined ? { agents: input.agents } : {}),
    // The kernel omits an empty trigger list when serializing RunSpec. Normalize
    // it here so the authoring shape and boundary shape retain one hashable form.
    ...(input.triggers?.length ? { triggers: input.triggers } : {}),
    steps,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  };
  return flow;
}

function compileStep(step: StepSpec): StepSpec {
  const maxIterations = step.maxIterations ?? 1;
  const verification = typedOutputVerification(step);
  const base = {
    id: step.id,
    type: step.type,
    ...((step.dependsOn !== undefined || step.input !== undefined)
      ? { dependsOn: step.input === undefined ? step.dependsOn : [...new Set([...(step.dependsOn ?? []), ...bindingDependencies(step.input)])] } : {}),
    ...(step.input !== undefined ? { input: step.input } : {}),
    maxIterations,
    ...(step.memory !== undefined ? { memory: step.memory } : {}),
    ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
  };

  switch (step.type as StepType) {
    case 'deterministic': {
      const s = step as DeterministicStepSpec;
      // A deterministic step with no verification gets the implicit exit_code
      // gate. Read the SHARED `verification`, never `s.verification`: for this
      // verb the two are equal today (typedOutputVerification returns
      // `step.verification` unchanged, because `output` is not authorable on a
      // deterministic step), but reading the shared binding is what keeps every
      // branch of this switch on the lowered gate rather than the raw authored
      // one. See ops/reviews/20260903-pr139-repair-0903.md §10, trap 2.
      return {
        ...base,
        type: 'deterministic',
        command: s.command,
        verification: verification ?? { type: 'exit_code' as const },
        // #138: `timeoutMs` is deterministic-only — worker-backed verbs own
        // their dispatch timeout. It must be spread HERE and nowhere in `base`.
        ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
        ...(s.lease_ms !== undefined ? { lease_ms: parseStepTimeout(s.lease_ms) } : {}),
      };
    }
    case 'llm': {
      const s = step as LlmStepSpec;
      return {
        ...base,
        type: 'llm',
        prompt: s.prompt,
        // From the shared `verification` — which may have been lowered from an
        // `output` declaration — never from `s.verification`, which would drop
        // that lowering.
        ...(verification !== undefined ? { verification: outputGate(verification, s.id) } : {}),
        ...(s.model !== undefined ? { model: s.model } : {}),
        ...(s.cli !== undefined ? { cli: s.cli } : {}),
      };
    }
    case 'agent': {
      const s = step as AgentStepSpec;
      const recoveryMode = s.recoveryMode ?? 'reset';
      return {
        ...base,
        type: 'agent',
        instruction: s.instruction,
        ...(verification !== undefined ? { verification: outputGate(verification, s.id) } : {}),
        ...(s.agent !== undefined ? { agent: s.agent } : {}),
        ...(s.cli !== undefined ? { cli: s.cli } : {}),
        ...(s.model !== undefined ? { model: s.model } : {}),
        recoveryMode,
        ...(s.surfaces !== undefined ? { surfaces: s.surfaces } : {}),
        ...(s.permissions !== undefined ? { permissions: s.permissions } : {}),
      };
    }
    default:
      // validateSpec already gated this; unreachable.
      throw new CompileError([`step "${step.id}": unknown type "${String((step as { type: unknown }).type)}"`]);
  }
}

/**
 * Narrow a gate to the ones an `llm`/`agent` step may carry. `validateSpec`
 * already refuses `exit_code` off a deterministic step, so this is the
 * fail-closed backstop for a runtime value cast past the authoring types.
 */
function outputGate(gate: VerificationSpec, stepId: string): OutputVerificationSpec {
  if (gate.type === 'exit_code') {
    throw new CompileError([
      `step "${stepId}": exit_code is supported only on deterministic steps`,
    ]);
  }
  return gate;
}

function typedOutputVerification(step: StepSpec): StepSpec['verification'] {
  if (step.type !== 'deterministic' && step.output !== undefined) {
    const errors = validateOutputDeclaration(step, `step "${step.id}"`);
    if (errors.length > 0) throw new CompileError(errors);
    return { type: 'json_schema', schema: step.output };
  }
  return step.verification;
}

/**
 * Resolve declarative named-agent sugar at kernel lowering. Explicit step
 * fields win independently, so an author may override
 * only the CLI or only the model. The selector and declaration map never
 * cross the journal boundary.
 */
function resolveNamedAgent(
  step: StepSpec,
  agents: Record<string, NamedAgentSpec> | undefined,
): StepSpec {
  if (step.type !== 'agent' || step.agent === undefined) return step;
  const declaration = agents !== undefined && Object.hasOwn(agents, step.agent)
    ? agents[step.agent]
    : undefined;
  if (declaration === undefined) {
    throw new CompileError([
      `step "${step.id}": unknown named agent "${step.agent}"`,
    ]);
  }
  return {
    ...step,
    ...(step.cli === undefined ? { cli: declaration.cli } : {}),
    ...(step.model === undefined ? { model: declaration.model } : {}),
  };
}

// Kernel defaults, materialized at compile time so the emitted spec is
// byte-identical to the kernel's own serialization of it (spec.rs defaults).
const KERNEL_RETRY_DEFAULTS = {
  initial_backoff_ms: 100,
  max_backoff_ms: 60_000,
  multiplier: 2,
  jitter_percent: 20,
} as const;

/**
 * Map an authoring `FlowSpec` to the kernel spec dialect — the single shape at
 * the SDK↔kernel boundary (`kernel/relayflowd-core/src/spec.rs`). Authoring
 * sugar that the dialect cannot carry is a `CompileError`, never a silent drop.
 */
export function toKernelSpec(flow: FlowSpec): KernelRunSpec {
  // This public boundary is callable without compileSpec. Compile again so
  // runtime casts are validated and all returned schema data is snapshotted.
  const compiled = compileSpec(flow);

  return {
    version: compiled.version,
    ...(compiled.name !== undefined ? { name: compiled.name } : {}),
    ...(compiled.description !== undefined ? { description: compiled.description } : {}),
    ...(compiled.cli !== undefined ? { cli: compiled.cli } : {}),
    // Both halves are load-bearing, and this hunk is trap 2's shape a second
    // time. `compiled.*` is #139's snapshot guard: this boundary is callable
    // without compileSpec, so it recompiles and reads the validated, snapshotted
    // spec rather than the caller's raw object. `.map(toKernelTrigger)` is
    // #151's LOWERING of authoring trigger keys into the kernel dialect --
    // authoring sugar that becomes a different object at the boundary, exactly
    // like `output:`. Taking either side of this conflict wholesale silently
    // reverts the other, and `validateSpec` and `flows check` would both still
    // look correct. See ops/reviews/20260903-pr139-repair-0903.md section 10.
    ...(compiled.triggers?.length ? { triggers: compiled.triggers.map(toKernelTrigger) } : {}),
    steps: lowerNamedGates(compiled.steps).map((step) => toKernelStep(resolveNamedAgent(step, compiled.agents))),
    ...(compiled.budget !== undefined ? { budget: toKernelBudget(compiled.budget) } : {}),
  };
}

/**
 * Map the kernel boundary dialect back to the normalized authoring shape.
 * This is the inverse of `toKernelSpec` over specs this compiler emits.
 * Kernel-only values with no authoring representation are refused.
 */
export function kernelToAuthoring(value: unknown): unknown {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonValue(value, 'spec');
  } catch (error) {
    throw new CompileError([
      error instanceof Error ? error.message : 'spec: expected JSON-compatible data',
    ]);
  }
  const root = requireKernelObject(
    snapshot,
    ['version', 'name', 'description', 'cli', 'triggers', 'steps', 'budget'],
    'spec',
  );
  const steps = requireKernelArray(root['steps'], 'spec.steps')
    .map((step, index) => kernelStepToAuthoring(step, `spec.steps[${index}]`));
  const triggers = root['triggers'];
  return {
    ...copyDefined(root, ['version', 'name', 'description', 'cli']),
    ...(triggers !== undefined
      ? {
          triggers: requireKernelArray(triggers, 'spec.triggers')
            .map((trigger, index) => kernelTriggerToAuthoring(trigger, `spec.triggers[${index}]`)),
        }
      : {}),
    steps,
    ...(root['budget'] !== undefined
      ? { budget: kernelBudgetToAuthoring(root['budget'], 'spec.budget') }
      : {}),
  };
}

/**
 * Lower one authoring trigger into the kernel dialect.
 *
 * This mapping was missing entirely: `toKernelSpec` used to spread
 * `flow.triggers` through untouched, so every event subscription reached the
 * kernel in camelCase and `relayflowd` — whose `TriggerSpec` is
 * `#[serde(deny_unknown_fields)]` over snake_case — refused the spec outright:
 *
 *   malformed run spec: unknown field `dedupeKeyTemplate`, expected one of
 *   `id`, `executor`, `event_type`, `pattern`, `dedupe_key_template`,
 *   `stale_after_ms`
 *
 * The committed `testdata/*.spec.canonical.json` fixtures are snake_case and
 * the kernel accepts them, which is why nothing noticed: no test compiled a
 * triggered flow through this function and compared it to a fixture. Every
 * triggered flow in `testdata/` was therefore unauthorable through the
 * supported SDK path. `tests/spec-parity.test.ts` now pins the mapping.
 */
function toKernelTrigger(trigger: TriggerSpec): KernelTriggerSpec {
  return {
    id: trigger.id,
    executor: trigger.executor,
    ...(trigger.eventType !== undefined ? { event_type: trigger.eventType } : {}),
    ...(trigger.pattern !== undefined ? { pattern: trigger.pattern } : {}),
    ...(trigger.dedupeKeyTemplate !== undefined
      ? { dedupe_key_template: trigger.dedupeKeyTemplate }
      : {}),
    ...(trigger.staleAfterMs !== undefined ? { stale_after_ms: trigger.staleAfterMs } : {}),
  };
}

/** Inverse of `toKernelTrigger`. Kernel-only keys are refused, never dropped. */
function kernelTriggerToAuthoring(value: unknown, at: string): unknown {
  const trigger = requireKernelObject(
    value,
    ['id', 'executor', 'event_type', 'pattern', 'dedupe_key_template', 'stale_after_ms'],
    at,
  );
  return {
    id: trigger['id'],
    executor: trigger['executor'],
    ...(trigger['event_type'] !== undefined ? { eventType: trigger['event_type'] } : {}),
    ...(trigger['pattern'] !== undefined ? { pattern: trigger['pattern'] } : {}),
    ...(trigger['dedupe_key_template'] !== undefined
      ? { dedupeKeyTemplate: trigger['dedupe_key_template'] }
      : {}),
    ...(trigger['stale_after_ms'] !== undefined ? { staleAfterMs: trigger['stale_after_ms'] } : {}),
  };
}

function kernelStepToAuthoring(value: unknown, at: string): unknown {
  const unionKeys = [
    'id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification', 'memory', 'requirements', 'input',
    'command', 'timeout_ms', 'lease_ms', 'prompt', 'model', 'cli', 'instruction',
    'recovery_mode', 'surfaces', 'permissions',
  ] as const;
  const step = requireKernelObject(value, unionKeys, at);
  const type = step['type'];
  const commonKeys = ['id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification', 'memory', 'requirements', 'input'] as const;
  const typeKeys = type === 'deterministic'
    ? ['command', 'timeout_ms', 'lease_ms'] as const
    : type === 'llm'
      ? ['prompt', 'model', 'cli'] as const
      : type === 'agent'
        ? ['instruction', 'cli', 'model', 'recovery_mode', 'surfaces', 'permissions'] as const
        : [];
  assertKernelKeys(step, [...commonKeys, ...typeKeys], at);
  if (step['retry'] !== undefined) validateAuthoringRetryDefaults(step['retry'], `${at}.retry`);
  const dependsOn = step['depends_on'];
  const common = {
    id: step['id'],
    type,
    ...(step['input'] !== undefined ? { input: step['input'] } : {}),
    ...(step['requirements'] !== undefined ? { requirements: kernelRequirementsToAuthoring(step['requirements'], `${at}.requirements`) } : {}),
    ...(dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.length > 0)
      ? { dependsOn }
      : {}),
    ...(step['max_iterations'] !== undefined ? { maxIterations: step['max_iterations'] } : {}),
    ...kernelVerificationToAuthoring(type, step['verification'], `${at}.verification`),
    ...(step['memory'] !== undefined ? { memory: kernelMemoryToAuthoring(step['memory'], `${at}.memory`) } : {}),
  };
  if (type === 'deterministic') {
    return {
      ...common,
      command: step['command'],
      ...(step['timeout_ms'] !== undefined ? { timeoutMs: step['timeout_ms'] } : {}),
      ...(step['lease_ms'] !== undefined ? { lease_ms: step['lease_ms'] } : {}),
    };
  }
  if (type === 'llm') {
    return { ...common, prompt: step['prompt'], ...copyDefined(step, ['model', 'cli']) };
  }
  if (type === 'agent') {
    return {
      ...common,
      instruction: step['instruction'],
      ...(step['recovery_mode'] !== undefined ? { recoveryMode: step['recovery_mode'] } : {}),
      ...copyDefined(step, ['cli', 'model', 'surfaces']),
      ...(step['permissions'] !== undefined
        ? { permissions: kernelPermissionsToAuthoring(step['permissions'], `${at}.permissions`) }
        : {}),
    };
  }
  return common;
}

function validateAuthoringRetryDefaults(value: unknown, at: string): void {
  const retry = requireKernelObject(value, [
    'initial_backoff_ms', 'max_backoff_ms', 'multiplier', 'jitter_percent',
  ], at);
  for (const [field, expected] of Object.entries(KERNEL_RETRY_DEFAULTS)) {
    if (retry[field] !== expected) {
      throw new CompileError([
        `${at}.${field} must equal the authoring default ${expected}`,
      ]);
    }
  }
}

function kernelVerificationToAuthoring(
  type: unknown,
  value: unknown,
  at: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  const verification = requireKernelObject(value, ['output_contains', 'json_schema'], at);
  if (verification['output_contains'] !== undefined && verification['json_schema'] !== undefined) {
    throw new CompileError([`${at} may not contain two gates in spec v0.1.0`]);
  }
  if (verification['output_contains'] !== undefined) {
    return { verification: { type: 'output_contains', value: verification['output_contains'] } };
  }
  if (verification['json_schema'] !== undefined) {
    return { verification: { type: 'json_schema', schema: verification['json_schema'] } };
  }
  return type === 'deterministic' ? { verification: { type: 'exit_code' } } : {};
}

function kernelMemoryToAuthoring(value: unknown, at: string): unknown {
  const memory = requireKernelObject(value, ['scope', 'query', 'budget'], at);
  return {
    scope: memory['scope'], query: memory['query'],
    budget: kernelBudgetToAuthoring(memory['budget'], `${at}.budget`),
  };
}

function kernelBudgetToAuthoring(value: unknown, at: string): unknown {
  const budget = requireKernelObject(value, ['max_tokens_in', 'max_tokens_out', 'max_dollars', 'max_tokens', 'max_wallclock_ms', 'window', 'pricing'], at);
  return {
    ...(budget['pricing'] !== undefined ? { pricing: budget['pricing'] } : {}),
    ...(budget['max_tokens'] !== undefined ? { maxTokens: budget['max_tokens'] } : {}),
    ...(budget['max_wallclock_ms'] !== undefined ? { maxWallclockMs: budget['max_wallclock_ms'] } : {}),
    ...(budget['window'] !== undefined ? { window: budget['window'] } : {}),
    ...(budget['max_tokens_in'] !== undefined ? { maxTokensIn: budget['max_tokens_in'] } : {}),
    ...(budget['max_tokens_out'] !== undefined ? { maxTokensOut: budget['max_tokens_out'] } : {}),
    ...(budget['max_dollars'] !== undefined ? { maxDollars: budget['max_dollars'] } : {}),
  };
}

function kernelPermissionsToAuthoring(value: unknown, at: string): unknown {
  const permissions = requireKernelObject(value, ['file_globs', 'network_allowlist', 'access_preset'], at);
  return {
    ...(permissions['file_globs'] !== undefined ? { fileGlobs: permissions['file_globs'] } : {}),
    ...(permissions['network_allowlist'] !== undefined ? { networkAllowlist: permissions['network_allowlist'] } : {}),
    ...(permissions['access_preset'] !== undefined ? { accessPreset: permissions['access_preset'] } : {}),
  };
}

function requireKernelObject(
  value: unknown,
  allowed: readonly string[],
  at: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new CompileError([`${at}: expected an object`]);
  }
  assertKernelKeys(value, allowed, at);
  return value;
}

function assertKernelKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new CompileError([
      `${at}: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map((key) => `"${key}"`).join(', ')} (expected one of ${allowed.join(' | ')})`,
    ]);
  }
}

function requireKernelArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new CompileError([`${at}: expected an array`]);
  return value;
}

function copyDefined(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toKernelStep(step: StepSpec): KernelStepSpec {
  const common: KernelStepCommon = {
    id: step.id,
    depends_on: step.input === undefined ? step.dependsOn ?? []
      : [...new Set([...(step.dependsOn ?? []), ...bindingDependencies(step.input)])],
    ...(step.input !== undefined ? { input: step.input } : {}),
    max_iterations: step.maxIterations ?? 1,
    retry: { ...KERNEL_RETRY_DEFAULTS },
    verification: toKernelVerification(step),
    ...(step.requirements !== undefined ? { requirements: {
      ...Object.fromEntries(Object.entries(step.requirements).filter(([key]) => key !== 'expectedDurationMs')),
      ...(step.requirements.expectedDurationMs !== undefined ? { expected_duration_ms: step.requirements.expectedDurationMs } : {}),
    } } : {}),
    ...(step.memory !== undefined ? { memory: {
      scope: step.memory.scope,
      query: step.memory.query,
      budget: {
        ...(step.memory.budget.maxTokensIn !== undefined ? { max_tokens_in: step.memory.budget.maxTokensIn } : {}),
        ...(step.memory.budget.maxTokensOut !== undefined ? { max_tokens_out: step.memory.budget.maxTokensOut } : {}),
        ...(step.memory.budget.maxDollars !== undefined ? { max_dollars: step.memory.budget.maxDollars } : {}),
      },
    } } : {}),
  };
  switch (step.type) {
    case 'deterministic':
      return {
        ...common,
        type: 'deterministic',
        command: step.command,
        ...(step.timeoutMs !== undefined ? { timeout_ms: step.timeoutMs } : {}),
        ...(step.lease_ms !== undefined ? { lease_ms: parseStepTimeout(step.lease_ms) } : {}),
      };
    case 'llm': {
      return {
        ...common,
        type: 'llm',
        prompt: step.prompt,
        ...(step.model !== undefined ? { model: step.model } : {}),
        ...(step.cli !== undefined ? { cli: step.cli } : {}),
      };
    }
    case 'agent': {
      const out: KernelAgentStep = {
        ...common,
        type: 'agent',
        instruction: step.instruction,
        ...(step.cli !== undefined ? { cli: step.cli } : {}),
        ...(step.model !== undefined ? { model: step.model } : {}),
        recovery_mode: step.recoveryMode ?? 'reset',
      };
      const surfaces = {
        ...(step.surfaces?.workspace?.length ? { workspace: step.surfaces.workspace.map((w) => ({ surface: w.surface })) } : {}),
        ...(step.surfaces?.streams?.length ? { streams: step.surfaces.streams.map((s) => ({ stream: s.stream })) } : {}),
        ...(step.surfaces?.external?.length ? { external: step.surfaces.external } : {}),
      };
      if (Object.keys(surfaces).length > 0) out.surfaces = surfaces;
      if (step.permissions !== undefined) {
        out.permissions = {
          ...(step.permissions.fileGlobs !== undefined ? { file_globs: step.permissions.fileGlobs } : {}),
          ...(step.permissions.networkAllowlist !== undefined ? { network_allowlist: step.permissions.networkAllowlist } : {}),
          ...(step.permissions.accessPreset !== undefined ? { access_preset: step.permissions.accessPreset } : {}),
        };
      }
      return out;
    }
  }
}

function toKernelVerification(step: StepSpec): KernelVerificationSpec {
  const output = step.type === 'deterministic' ? undefined : step.output;
  if (output !== undefined) {
    const errors = validateOutputDeclaration(step, `step "${step.id}"`);
    if (errors.length > 0) throw new CompileError(errors);
    return { json_schema: output };
  }
  const gate = step.verification;
  // Validation permits explicit exit_code only on deterministic steps, where
  // {} selects the kernel's implicit exit_code == 0 gate (DESIGN.md §4).
  if (gate === undefined || gate.type === 'exit_code') return {};
  if (gate.type === 'output_contains') return { output_contains: gate.value };
  if (gate.type === 'json_schema') return { json_schema: gate.schema };
  throw new CompileError([
    `step "${step.id}".verification.type: expected exit_code | output_contains | json_schema`,
  ]);
}

/**
 * Compile + hash in one call. `hash` is sha256 of the kernel-dialect canonical
 * JSON — the spec identity the kernel stamps as `spec_hash` in `run.spawned`.
 */
export function compileAndHash(yaml: string): { spec: FlowSpec; kernelSpec: KernelRunSpec; hash: string } {
  const spec = compileYaml(yaml);
  const kernelSpec = toKernelSpec(spec);
  return { spec, kernelSpec, hash: specHash(kernelSpec) };
}

export { SPEC_SCHEMA_VERSION, canonicalize, specHash };

function kernelRequirementsToAuthoring(value: unknown, at: string): unknown {
  const requirements = requireKernelObject(value, ['execution', 'workspace', 'network', 'expected_duration_ms', 'preference'], at);
  return {
    ...copyDefined(requirements, ['execution', 'workspace', 'network', 'preference']),
    ...(requirements['expected_duration_ms'] !== undefined ? { expectedDurationMs: requirements['expected_duration_ms'] } : {}),
  };
}
