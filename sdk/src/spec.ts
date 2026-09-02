// Spec types for Relayflows — data, not code (RFC-0001 settled decision #5).
//
// Mirrors RFC-0001 §1's ladder. Every rung is a legal relayflow:
//   deterministic step          # a pure script — no LLM anywhere (legal)
//     + llm step                # a bare model call — prompt in, verified output out
//       + agent step            # a harnessed agent in a workspace — artifact + diff + trajectory
//
// Step types are exactly `deterministic | llm | agent` (AGENTS.md rule 7).
// Zero-agent flows are legal: a spec with only `deterministic` (and/or `llm`)
// steps is valid. Nothing here requires an `agent` step.

import type { JsonOutputSchema } from './output-schema.js';
export type { JsonOutputSchema } from './output-schema.js';

/** The three rungs of the ladder (RFC §1; AGENTS.md rule 7). */
export type StepType = 'deterministic' | 'llm' | 'agent';

/**
 * Verification is control flow, not decoration (kernel DESIGN.md §3).
 * v0 gates are deterministic so verification is kernel-side and replayable.
 */
export type VerificationGateType = 'exit_code' | 'output_contains' | 'json_schema';

/**
 * `exit_code == 0` — the implicit gate for deterministic steps. v0 judges
 * exactly zero (kernel DESIGN.md §4); it is not configurable, so this gate
 * carries no parameters. Writing it explicitly is allowed and compiles to the
 * same kernel spec as omitting it.
 */
export interface ExitCodeGate {
  type: 'exit_code';
}

/** Step output (stdout_tail / llm value, stringified) contains `value`. */
export interface OutputContainsGate {
  type: 'output_contains';
  value: string;
}

/** Step output validates against a JSON Schema. Used for `llm` structured output. */
export interface JsonSchemaGate {
  type: 'json_schema';
  schema: boolean | Record<string, unknown>;
}

export type VerificationSpec = ExitCodeGate | OutputContainsGate | JsonSchemaGate;
export type OutputVerificationSpec = OutputContainsGate | JsonSchemaGate;

/**
 * Agent-step recovery modes (RFC Appendix A rule 4). Default is `reset`.
 * `deterministic` / `llm` steps have no workspace, so these do not apply.
 */
export type RecoveryMode = 'reset' | 'inspect' | 'manual';

/**
 * Declared mutable surfaces for an agent step (RFC Appendix A rule 1).
 * Anything undeclared is outside the contract and outside the step's
 * permissions (gate 8 makes this enforceable, not advisory).
 */
export interface WorkspaceSurface {
  /** Relayfile mount path, or a named worktree. */
  surface: string;
}

export interface StreamSurface {
  /** Durable channel the agent may write (kernel DESIGN.md §1.8). */
  stream: string;
}

export interface AgentSurfaces {
  workspace?: WorkspaceSurface[];
  streams?: StreamSurface[];
  /** Integration writeback paths — mount writes per gate 6. */
  external?: string[];
}

/** Permission model for an agent step (gate 8). `readonly` provably cannot write. */
export interface PermissionsSpec {
  fileGlobs?: string[];
  networkAllowlist?: string[];
  accessPreset?: 'readonly' | 'readwrite';
}

/**
 * Budget envelope. Per decision #10 every token has exactly one owner: an
 * injected context pack spends the consuming step's budget. Money is a decimal
 * string at the boundary (kernel DESIGN.md §1: no floats for money); tokens
 * are integers.
 */
export interface BudgetSpec {
  maxTokensIn?: number;
  maxTokensOut?: number;
  /** Decimal string, e.g. "1.50". */
  maxDollars?: string;
}

/** Fields shared by every step on the ladder. */
export interface BaseStepSpec {
  /** Stable step identity; journaled as `step_id` and hashed into the idempotency key. */
  id: string;
  type: StepType;
  /** Step dependencies — a step runs only after these complete. */
  dependsOn?: string[];
  /** Semantic retry bound (kernel DESIGN.md §1.2 `max_iterations`). Default 1. */
  maxIterations?: number;
}

/**
 * Rung 1 — a pure script. Executed by the `relayflowd` binary: spawn command,
 * capture stdout/exit code. Output = `{exit_code, stdout_tail}`. Gate-1
 * deterministic steps are pure (no pins).
 */
export interface DeterministicStepSpec extends BaseStepSpec {
  type: 'deterministic';
  command: string;
  /** Omit to get the implicit `exit_code` gate. */
  verification?: VerificationSpec;
}

/**
 * Rung 2 — a bare model call. No workspace, output is a value. The kernel
 * never calls a model: it dispatches to an attached SDK worker (§5) which
 * returns `{output, usage}`; the kernel then runs the verification gate.
 */
export interface LlmStepSpec extends BaseStepSpec {
  type: 'llm';
  prompt: string;
  verification?: OutputVerificationSpec;
  model?: string;
  /** Inert preflight declaration; overrides the flow/project CLI default. */
  cli?: string;
  /**
   * Structured-output authoring sugar. Compiles to the existing `json_schema`
   * verification primitive and is removed before the kernel boundary.
   */
  output?: JsonOutputSchema;
}

/**
 * Rung 3 — a harnessed agent in a workspace. Dispatched like `llm`, plus
 * Appendix A in full: pins declared workspace revisions and stream offsets;
 * every writeback is a journaled `effect.recorded` deduped by
 * `(step_id, idempotency_key, surface_path)`.
 */
export interface AgentStepSpec extends BaseStepSpec {
  type: 'agent';
  instruction: string;
  verification?: OutputVerificationSpec;
  /** Inert preflight declaration; overrides the flow/project CLI default. */
  cli?: string;
  /**
   * Model the declared CLI must use. Raw Claude/Codex adapters receive their
   * real model flag; an identified Relayflows wrapper receives
   * `RELAYFLOW_MODEL`. Declared here so the choice is journaled with the step
   * instead of being ambient host state.
   */
  model?: string;
  surfaces?: AgentSurfaces;
  recoveryMode?: RecoveryMode;
  permissions?: PermissionsSpec;
  /**
   * Structured-output authoring sugar. A successful CLI JSON object is the parsed
   * value; the kernel persists it only after `json_schema` verification.
   */
  output?: JsonOutputSchema;
}

export type StepSpec = DeterministicStepSpec | LlmStepSpec | AgentStepSpec;

/**
 * Reusable authoring declaration for an agent CLI/model pair. Both fields are
 * required so selecting a named agent can never inherit a host model. The
 * compiler lowers these values into the selected kernel agent step at the
 * journal boundary; the kernel never receives this map or a new step field.
 */
export interface NamedAgentSpec {
  cli: string;
  model: string;
}

/** Inert gate-1 trigger declaration. Matching and dispatch belong to gate 2. */
export interface TriggerSpec {
  id: string;
  /** Executor registration required before this trigger may start a run. */
  executor: string;
}

/**
 * A Relayflow spec in the authoring shape — the composable unit (RFC settled
 * decision #5). Schema-validated, diffable, signable (gate 8), and emittable
 * by a step (gate 9 self-authoring). What the kernel inlines in `run.spawned`
 * is this spec mapped to the kernel dialect (`toKernelSpec`).
 */
export interface FlowSpec {
  /** Spec schema semver (RFC §7). Compilers always emit latest. */
  version: string;
  name?: string;
  description?: string;
  /** Inert preflight default for llm/agent steps that do not declare a CLI. */
  cli?: string;
  /** Named authoring declarations. Compiled into agent steps, never journaled as a new primitive. */
  agents?: Record<string, NamedAgentSpec>;
  /** Declarations checked by preflight; gate 1 never dispatches them. */
  triggers?: TriggerSpec[];
  steps: StepSpec[];
  budget?: BudgetSpec;
}

/** Current spec schema version emitted by this SDK. */
export const SPEC_SCHEMA_VERSION = '0.1.0';

// --- The kernel dialect ------------------------------------------------------
//
// The authoring types above are TypeScript-idiomatic (camelCase, tagged
// verification sugar). The *boundary artifact* is singular: the kernel's spec
// dialect — snake_case keys, semver `version`, flat v0 verification, defaults
// materialized. `toKernelSpec` (compile.ts) maps authoring → kernel; parity
// with `kernel/relayflowd-core/src/spec.rs` is pinned bit-for-bit by
// `tests/spec-parity.test.ts` and the kernel's `tests/spec_parity.rs` over the
// shared `testdata/` fixture.

export interface KernelRetryPolicy {
  initial_backoff_ms: number;
  max_backoff_ms: number;
  multiplier: number;
  jitter_percent: number;
}

/**
 * Flat v0 gates (kernel DESIGN.md §4): `exit_code == 0` is implicit for
 * deterministic steps; these two are optional and combinable. An empty object
 * means "implicit gates only".
 */
export interface KernelVerificationSpec {
  output_contains?: string;
  json_schema?: boolean | Record<string, unknown>;
}

export interface KernelStepCommon {
  id: string;
  depends_on: string[];
  max_iterations: number;
  retry: KernelRetryPolicy;
  verification: KernelVerificationSpec;
}

export interface KernelDeterministicStep extends KernelStepCommon {
  type: 'deterministic';
  command: string;
  timeout_ms?: number;
}

export interface KernelLlmStep extends KernelStepCommon {
  type: 'llm';
  prompt: string;
  model?: string;
  cli?: string;
}

export interface KernelAgentSurfaces {
  workspace?: { surface: string }[];
  streams?: { stream: string }[];
  external?: string[];
}

export interface KernelPermissionsSpec {
  file_globs?: string[];
  network_allowlist?: string[];
  access_preset?: 'readonly' | 'readwrite';
}

export interface KernelAgentStep extends KernelStepCommon {
  type: 'agent';
  instruction: string;
  cli?: string;
  model?: string;
  recovery_mode: RecoveryMode;
  surfaces?: KernelAgentSurfaces;
  permissions?: KernelPermissionsSpec;
}

export type KernelStepSpec = KernelDeterministicStep | KernelLlmStep | KernelAgentStep;

export interface KernelBudgetSpec {
  max_tokens_in?: number;
  max_tokens_out?: number;
  max_dollars?: string;
}

export interface KernelTriggerSpec {
  id: string;
  executor: string;
}

/** The compiled spec as the kernel parses, journals, and hashes it. */
export interface KernelRunSpec {
  version: string;
  name?: string;
  description?: string;
  cli?: string;
  triggers?: KernelTriggerSpec[];
  steps: KernelStepSpec[];
  budget?: KernelBudgetSpec;
}
