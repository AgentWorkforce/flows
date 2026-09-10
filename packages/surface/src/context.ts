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
  /** Overrides a named declaration's (or the flow/project default's) CLI for this step only. */
  cli?: string;
  /** Overrides a named declaration's model for this step only. No flow/project default exists for model. */
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
  agent(name: string, options: AgentOptions): Step<AgentResult>;
  human(question: string, options: { to: string }): Promise<boolean>;
  dispatch<T>(flow: string, input: unknown): Promise<T>;
  done(reason: RunCompletionReason): void;
  cloud: CloudHelper;
}
