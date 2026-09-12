/** A journal-backed step result with its postfix verification gate. */
export interface Step<T> extends PromiseLike<T> {
  /**
   * Attach a named data gate to this step's `verification:` field. The gate is
   * lowered by the SDK into a slice-P journal-honest check that survives
   * replay — its shape is data, not code, so covenant 1 (journal-as-truth)
   * holds. See `packages/sdk/src/named-gates.ts` for the enforcement.
   */
  gate(config: NamedGate): Step<T>;
  /**
   * Predicate gates cannot be journaled — the JavaScript closure would not
   * survive replay — so the executor refuses this branch with
   * `unsupported_gate`. Use a `NamedGate` config-object gate above, or the
   * declarative `verification:` field on the compiled step spec, when you
   * need journal-honest verification.
   */
  gate(predicate: (value: T) => boolean, because?: string): Step<T>;
}

/**
 * Slice-P named data gates the authored surface can attach postfix via
 * `.gate(config)`. The SDK's named-gate lowering enforces these exactly (see
 * `packages/sdk/src/named-gates.ts`); the shapes here are the surface-visible
 * subset kept in sync with `NamedDataGate` in the SDK spec.
 */
export type NamedGate =
  | ReferencesInputNamedGate
  | SubprocessNamedGate
  | WordCountBoundsNamedGate
  | RegexMatchNamedGate;

export interface ReferencesInputNamedGate {
  type: 'references_input';
  input_key: string;
  in_output_at?: Array<string | number>;
}

export interface SubprocessNamedGate {
  type: 'subprocess_gate';
  command: string;
  from_output?: Array<string | number>;
}

export interface WordCountBoundsNamedGate {
  type: 'word_count_bounds';
  min?: number;
  max?: number;
}

export interface RegexMatchNamedGate {
  type: 'regex_match';
  pattern: string;
  /** Only i, m, and s; evaluated by a non-backtracking RE2 engine. */
  flags?: string;
  in_output_at?: Array<string | number>;
}
