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
  /**
   * Directory this agent's CLI is spawned in, relative to the run root — the
   * flow-runner's working directory, and where the CLI runs when this is
   * absent. One flow can therefore drive agents in sibling checkouts. The
   * path must be relative and free of `.`, `..` and empty components, and
   * must name an existing directory inside the run root at dispatch;
   * anything else refuses the step instead of running it somewhere else.
   * An absolute path is accepted when it names a directory inside the run
   * root — it lowers to the same relative declaration — and refused when it
   * escapes. `artifacts` are reported relative to this directory. It is a
   * declaration of where to start, not a sandbox. Not supported with
   * `transport: 'relay'`. See docs/SURFACE.md.
   */
  cwd?: string;
  /**
   * Dispatch transport (flows#385). `'direct'` (default) spawns the CLI as a
   * local subprocess. `'relay'` posts to agent-relay so the agent registers
   * as a first-class workspace participant that DMs can steer.
   */
  transport?: 'direct' | 'relay';
}

/**
 * What `f.run` resolves to under `onNonZero: 'record'`.
 *
 * Every field is read back from the step's journaled output envelope, never
 * re-measured: `ok` is the recorded exit code, not a second execution. This is
 * the point of the policy — `<command> || true` discards the code, so the
 * branch below it can only ever be taken on faith.
 */
export interface RunResult {
  /** Exactly `exitCode === 0`. */
  ok: boolean;
  /** The exit code the kernel journaled for this command. */
  exitCode: number;
  /**
   * `stdout` then `stderr`, joined by a newline when both are nonempty — the
   * string to hand an agent asked to repair what the command reported. It is a
   * diagnostic convenience, not a reconstruction of the real interleaving: the
   * two streams were captured separately and their true ordering is not
   * journaled. Read `stdout` when you need to parse the command's own output.
   */
  output: string;
  /** stdout tail — the same string the default `f.run` resolves to. */
  stdout: string;
  /** stderr tail, where a failing check usually explains itself. */
  stderr: string;
}

export interface RunOptions {
  /** Command lease: milliseconds or a duration such as "5m"; default 30s, maximum 15m. */
  timeout?: string | number;
  /**
   * What a nonzero exit means. `'fail'` (the default) throws, ending the flow
   * at this line. `'record'` journals the exit code and output and resolves to
   * a `RunResult`, so the body can hand a red check's own output to whatever is
   * built to repair it. A timeout, a signal, or a step that never ran still
   * throws under either policy: those produced no verdict to record.
   */
  onNonZero?: 'fail' | 'record';
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
  /**
   * Run a command. Resolves to its stdout tail, and a nonzero exit ends the
   * flow — unless `onNonZero: 'record'` is declared, which resolves to a
   * `RunResult` carrying the journaled exit code instead.
   *
   * The literal overloads come first so the default stays the common case: an
   * omitted or `'fail'` policy keeps the `Step<string>` every existing body is
   * written against, and only the literal `'record'` widens the result. The
   * third is for a policy held in a variable, where neither literal applies and
   * the author has to narrow the union themselves.
   */
  run(command: string, options?: RunOptions & { onNonZero?: 'fail' }): Step<string>;
  run(command: string, options: RunOptions & { onNonZero: 'record' }): Step<RunResult>;
  run(command: string, options: RunOptions): Step<string | RunResult>;
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
