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
import type {
  AgentStepSpec,
  DeterministicStepSpec,
  FlowSpec,
  KernelAgentStep,
  KernelRunSpec,
  KernelStepCommon,
  KernelStepSpec,
  KernelVerificationSpec,
  LlmStepSpec,
  NamedAgentSpec,
  StepSpec,
  StepType,
} from './spec.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import { canonicalize, specHash } from './canonical.js';
import { validateSpec, type ValidationResult } from './validate.js';

export class CompileError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super('spec compile failed:\n  - ' + errors.join('\n  - '));
    this.name = 'CompileError';
    this.errors = errors;
  }
}

/**
 * Compile a YAML string into a validated authoring `FlowSpec`.
 * Throws `CompileError` on a YAML parse error or any validation failure.
 */
export function compileYaml(yaml: string): FlowSpec {
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
export function compileSpec(spec: unknown): FlowSpec {
  const validation: ValidationResult = validateSpec(spec);
  if (!validation.ok) throw new CompileError(validation.errors);

  const input = spec as FlowSpec;
  const steps = input.steps.map((step) => compileStep(resolveNamedAgent(step, input.agents)));
  const flow: FlowSpec = {
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
  };
  return flow;
}

function compileStep(step: StepSpec): StepSpec {
  const maxIterations = step.maxIterations ?? 1;
  const base = {
    id: step.id,
    type: step.type,
    ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
    ...(step.verification !== undefined ? { verification: step.verification } : {}),
    maxIterations,
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
  };

  switch (step.type as StepType) {
    case 'deterministic': {
      const s = step as DeterministicStepSpec;
      // A deterministic step with no verification gets the implicit exit_code gate.
      const verification = s.verification ?? { type: 'exit_code' as const };
      return { ...base, type: 'deterministic', command: s.command, verification };
    }
    case 'llm': {
      const s = step as LlmStepSpec;
      return {
        ...base,
        type: 'llm',
        prompt: s.prompt,
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
 * Resolve declarative named-agent sugar before normalization or kernel
 * lowering. Explicit step fields win independently, so an author may override
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
  const validation = validateSpec(flow);
  if (!validation.ok) throw new CompileError(validation.errors);
  return {
    version: flow.version,
    ...(flow.name !== undefined ? { name: flow.name } : {}),
    ...(flow.description !== undefined ? { description: flow.description } : {}),
    ...(flow.cli !== undefined ? { cli: flow.cli } : {}),
    ...(flow.triggers?.length ? { triggers: flow.triggers } : {}),
    steps: flow.steps.map((step) => toKernelStep(resolveNamedAgent(step, flow.agents))),
    ...(flow.budget !== undefined
      ? {
          budget: {
            ...(flow.budget.maxTokensIn !== undefined ? { max_tokens_in: flow.budget.maxTokensIn } : {}),
            ...(flow.budget.maxTokensOut !== undefined ? { max_tokens_out: flow.budget.maxTokensOut } : {}),
            ...(flow.budget.maxDollars !== undefined ? { max_dollars: flow.budget.maxDollars } : {}),
          },
        }
      : {}),
  };
}

/**
 * Map the kernel boundary dialect back to the normalized authoring shape.
 * This is the inverse of `toKernelSpec` over specs this compiler emits.
 * Kernel-only values with no authoring representation are refused.
 */
export function kernelToAuthoring(value: unknown): unknown {
  const root = requireKernelObject(
    value,
    ['version', 'name', 'description', 'cli', 'triggers', 'steps', 'budget'],
    'spec',
  );
  const steps = requireKernelArray(root['steps'], 'spec.steps')
    .map((step, index) => kernelStepToAuthoring(step, `spec.steps[${index}]`));
  return {
    ...copyDefined(root, ['version', 'name', 'description', 'cli', 'triggers']),
    steps,
    ...(root['budget'] !== undefined
      ? { budget: kernelBudgetToAuthoring(root['budget'], 'spec.budget') }
      : {}),
  };
}

function kernelStepToAuthoring(value: unknown, at: string): unknown {
  const unionKeys = [
    'id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification',
    'command', 'timeout_ms', 'prompt', 'model', 'cli', 'instruction',
    'recovery_mode', 'surfaces', 'permissions',
  ] as const;
  const step = requireKernelObject(value, unionKeys, at);
  const type = step['type'];
  const commonKeys = ['id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification'] as const;
  const typeKeys = type === 'deterministic'
    ? ['command', 'timeout_ms'] as const
    : type === 'llm'
      ? ['prompt', 'model', 'cli'] as const
      : type === 'agent'
        ? ['instruction', 'cli', 'model', 'recovery_mode', 'surfaces', 'permissions'] as const
        : [];
  assertKernelKeys(step, [...commonKeys, ...typeKeys], at);
  if (step['retry'] !== undefined) validateKernelRetry(step['retry'], `${at}.retry`);
  const dependsOn = step['depends_on'];
  const common = {
    id: step['id'],
    type,
    ...(dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.length > 0)
      ? { dependsOn }
      : {}),
    ...(step['max_iterations'] !== undefined ? { maxIterations: step['max_iterations'] } : {}),
    ...kernelVerificationToAuthoring(type, step['verification'], `${at}.verification`),
  };
  if (type === 'deterministic') {
    return {
      ...common,
      command: step['command'],
      ...(step['timeout_ms'] !== undefined ? { timeoutMs: step['timeout_ms'] } : {}),
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

function validateKernelRetry(value: unknown, at: string): void {
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

function kernelBudgetToAuthoring(value: unknown, at: string): unknown {
  const budget = requireKernelObject(value, ['max_tokens_in', 'max_tokens_out', 'max_dollars'], at);
  return {
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
    depends_on: step.dependsOn ?? [],
    max_iterations: step.maxIterations ?? 1,
    retry: { ...KERNEL_RETRY_DEFAULTS },
    verification: toKernelVerification(step),
  };
  switch (step.type) {
    case 'deterministic':
      return {
        ...common,
        type: 'deterministic',
        command: step.command,
        ...(step.timeoutMs !== undefined ? { timeout_ms: step.timeoutMs } : {}),
      };
    case 'llm': {
      requireNoTimeout(step);
      return {
        ...common,
        type: 'llm',
        prompt: step.prompt,
        ...(step.model !== undefined ? { model: step.model } : {}),
        ...(step.cli !== undefined ? { cli: step.cli } : {}),
      };
    }
    case 'agent': {
      requireNoTimeout(step);
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

function requireNoTimeout(step: StepSpec): void {
  if (step.timeoutMs !== undefined) {
    throw new CompileError([
      `step "${step.id}": only deterministic steps carry a timeout in spec v${SPEC_SCHEMA_VERSION}`,
    ]);
  }
}

function toKernelVerification(step: StepSpec): KernelVerificationSpec {
  const gate = step.verification;
  // No gate / explicit exit_code both compile to {}: exit_code == 0 is the
  // kernel's implicit gate for deterministic steps (kernel DESIGN.md §4).
  if (gate === undefined || gate.type === 'exit_code') return {};
  if (gate.type === 'output_contains') return { output_contains: gate.value };
  return { json_schema: gate.schema };
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
