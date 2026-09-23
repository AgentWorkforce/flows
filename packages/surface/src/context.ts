import type { Helpers } from "./helpers/index.js";
import type { MemoryHelper } from "./memory.js";
import type { CloudCapabilities, CloudHelper } from "./cloud.js";
import type { FlowCompletionReason } from "./completion.js";
import type { Step } from "./step.js";

export interface AgentResult {
  summary: string;
  /**
   * Files the agent created or changed under its working directory,
   * cwd-relative POSIX paths, sorted — as journaled by the worker that spawned
   * the CLI on the step's `step.completed`, never re-measured later. Empty
   * for the relay transport (the agent ran elsewhere) and for an agent whose
   * final message is a JSON object (that object is the output, unmodified).
   */
  artifacts: string[];
}

/** Per-step declarations: validated and recorded, not currently enforced (gate 8 / #442).
 * Separate from flow-wide FlowHeader.workspace / tools.fs scopes.
 */
export interface PermissionsSpec {
  fileGlobs?: string[];
  networkAllowlist?: string[];
  accessPreset?: 'readonly' | 'readwrite';
}

export interface AgentOptions {
  task: string;
  workspace?: string;
  /** Validated declaration only; not currently enforced (gate 8 / #442). */
  permissions?: PermissionsSpec;
  cli?: string;
  model?: string;
  /** Working directory for the CLI subprocess; defaults to the flow-runner's cwd. */
  cwd?: string;
  /**
   * Dispatch transport (flows#385). `'direct'` (default) spawns the CLI as a
   * local subprocess. `'relay'` posts to agent-relay so the agent registers
   * as a first-class workspace participant that DMs can steer.
   */
  transport?: 'direct' | 'relay';
  /** Semantic executions allowed when verification rejects output. Default 1. */
  maxIterations?: number;
  /** Additional attempts allowed only after classified transport loss. Default 1. */
  transportRetries?: number;
  /** Appendix A workspace recovery for a transport retry. Default `reset`. */
  recoveryMode?: 'reset' | 'inspect' | 'manual';
}

export interface LlmOptions {
  /** JSON Schema checked before the result is accepted by the journal. */
  output: Record<string, unknown>;
  cli?: string;
  model?: string;
}

/**
 * The context a journal-backed runtime injects into a flow body.
 *
 * This package declares the authoring contract only. It cannot construct a
 * context or execute a step, so all effects remain behind the journal client.
 */
export interface Ctx extends Helpers {
  /** Host-verified ports. Absent from direct/local runs and ordinary authored execution. */
  readonly capabilities?: { readonly cloud?: CloudCapabilities };
  readonly mcp: Readonly<Record<string, Readonly<Record<string, (args: unknown) => Step<unknown>>>>>;
  /** Command lease: milliseconds or a duration such as "5m"; default 30s, maximum 15m. */
  run(command: string, options?: { timeout?: string | number }): Step<string>;
  llm(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
  /** JSON Schema validates the value at runtime; narrow unknown in author code. */
  llm(prompt: string, options: LlmOptions): Step<unknown>;
  agent(name: string, options: AgentOptions): Step<AgentResult>;
  /**
   * Ask a person a yes/no question and park until they answer. The run
   * parks durably (kernel `wait.human`); `flows answer <run> <wait> yes|no`
   * (or Cloud's answer route) records the answer and the resumed body
   * continues from this line with it. `to` names who is asked and is
   * recorded with the question; it is not a delivery address.
   */
  human(question: string, options: { to: string }): Step<boolean>;
  dispatch<T>(flow: string, input: unknown): Promise<T>;
  /**
   * Run every installed implementation of a named hook in lock order and
   * AND-compose the booleans. With no implementations this is a journaled
   * no-op that returns true. A name must appear in the flow header's `hooks`.
   */
  hook(name: string, input: unknown): Step<boolean>;
  done(reason: FlowCompletionReason): void;
  cloud: CloudHelper;
  memory: MemoryHelper;
}
