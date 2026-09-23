import type { Helpers } from "./helpers/index.js";
import type { MemoryHelper } from "./memory.js";
import type { CloudCapabilities, CloudHelper } from "./cloud.js";
import type { FlowCompletionReason } from "./completion.js";
import type { Step } from "./step.js";
import type { Activity, ActivityOptions } from "./activity.js";
import type { TriggerSource } from "./triggers.js";

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
}

export interface LlmOptions {
  /** JSON Schema checked before the result is accepted by the journal. */
  output: Record<string, unknown>;
  cli?: string;
  model?: string;
}

/** The optional second argument to {@link Ctx.done}. */
export interface DoneOptions {
  /** Why the flow reached this verdict; redacted, bounded, and journaled. */
  detail?: string;
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
  /** Open a durable, bounded event subscription for this running body. */
  on(source: TriggerSource, options: ActivityOptions): Activity;
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
  /**
   * End the flow with an authored verdict, and optionally say why.
   *
   * `options.detail` is free prose the flow already knows — "review found 1
   * P2: `review.clean` was not created" — and it is what a reader gets instead
   * of a generic sentence. It is journaled with the verdict, so it survives
   * into the run report and `flows status`; the runtime redacts it and bounds
   * it to `COMPLETION_DETAIL_MAX_CODE_POINTS` code points, truncating
   * with a visible marker rather than refusing an over-long one.
   *
   * Whitespace-only is the same as saying nothing: it normalizes to absence,
   * and the verdict reports exactly as the one-argument call does. A `detail`
   * that is present and not a string is refused.
   */
  done(reason: FlowCompletionReason, options?: DoneOptions): void;
  cloud: CloudHelper;
  memory: MemoryHelper;
}
