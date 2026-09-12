/**
 * First-class headless adapter contract (flows#141).
 *
 * Every supported agent CLI ships one implementation. `worker-cli.ts` and
 * `cli/check.ts` dispatch through the registry in `./index.ts` — never string
 * formatting against per-CLI knowledge inline. Adding a new CLI is one new
 * file that implements this interface.
 *
 * Behavior-preserving migration: the exported functions in `cli-adapter.ts`
 * (`agentExecution`, `llmExecution`, `authenticationProbe`,
 * `modelReadinessProbe`, `adapterIdentification`) now delegate to the
 * registered adapter for the resolved kind, so callers don't change.
 */

export interface CliInvocation {
  args: string[];
  timeoutMs: number;
  /** Set only for wrapper readiness probes; raw providers receive a model flag. */
  modelEnv?: string;
}

export interface CliAdapterIdentification {
  invocation: CliInvocation;
  expectedStdout?: string;
}

/**
 * The declared, per-CLI headless contract. Members intentionally mirror the
 * function-scoped predecessors in `cli-adapter.ts` so migration is mechanical.
 */
export interface HeadlessAdapter {
  /** Identity of this adapter — matches CliAdapterKind for registry keys. */
  readonly kind: string;

  /** Shape-check invocation before classifying an auth failure. */
  buildIdentification(): CliAdapterIdentification;

  /** Non-interactive auth-status probe. */
  buildAuthProbe(): CliInvocation;

  /**
   * Real, noninteractive model round-trip. Providers hand the model via a
   * native flag; wrappers hand it via the explicitly identified environment
   * contract on `modelEnv`.
   */
  buildModelReadinessProbe(model: string): CliInvocation;

  /** Agent-step worker argv for an instruction under an optional model. */
  buildAgentInvocation(instruction: string, model?: string): CliInvocation;

  /** LLM-step worker argv for a prompt under an optional model. */
  buildLlmInvocation(prompt: string, model?: string): CliInvocation;
}
