import type { SlackHelper } from "./slack.js";
import type { CloudHelper } from "./cloud.js";
import type { RunCompletionReason } from "./completion.js";
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
export interface Ctx {
  run(command: string): Step<string>;
  llm(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
  /** JSON Schema validates the value at runtime; narrow unknown in author code. */
  llm(prompt: string, options: LlmOptions): Step<unknown>;
  agent(name: string, options: AgentOptions): Step<AgentResult>;
  human(question: string, options: { to: string }): Promise<boolean>;
  dispatch<T>(flow: string, input: unknown): Promise<T>;
  done(reason: RunCompletionReason): void;
  cloud: CloudHelper;
  slack: SlackHelper;
}
