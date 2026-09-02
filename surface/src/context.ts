import type { CloudHelper } from "./cloud.js";

/** A journal-backed step result with its postfix verification gate. */
export interface Step<T> extends PromiseLike<T> {
  /** Fail the step with `gate_failed` when the predicate is false. */
  gate(predicate: (value: T) => boolean, because?: string): Step<T>;
}

export interface AgentResult {
  summary: string;
  artifacts: string[];
}

export interface AgentOptions {
  task: string;
  workspace?: string;
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
  done(reason: string): void;
  cloud: CloudHelper;
}
