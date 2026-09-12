import type { Helpers } from "./helpers/index.js";
import type { MemoryHelper } from "./memory.js";
import type { CloudHelper } from "./cloud.js";
import type { FlowCompletionReason } from "./completion.js";
import type { Step } from "./step.js";

export interface AgentResult {
  summary: string;
  artifacts: string[];
}

export interface AgentOptions {
  task: string;
  workspace?: string;
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

/**
 * The context a journal-backed runtime injects into a flow body.
 *
 * This package declares the authoring contract only. It cannot construct a
 * context or execute a step, so all effects remain behind the journal client.
 */
export interface Ctx extends Helpers {
  readonly mcp: Readonly<Record<string, Readonly<Record<string, (args: unknown) => Step<unknown>>>>>;
  /** Command lease: milliseconds or a duration such as "5m"; default 30s, maximum 15m. */
  run(command: string, options?: { timeout?: string | number }): Step<string>;
  llm(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
  /** JSON Schema validates the value at runtime; narrow unknown in author code. */
  llm(prompt: string, options: LlmOptions): Step<unknown>;
  agent(name: string, options: AgentOptions): Step<AgentResult>;
  human(question: string, options: { to: string }): Promise<boolean>;
  dispatch<T>(flow: string, input: unknown): Promise<T>;
  done(reason: FlowCompletionReason): void;
  cloud: CloudHelper;
  memory: MemoryHelper;
}
