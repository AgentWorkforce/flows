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
   * Predicate gate: author code, run once by the runtime after the step
   * completes, on the value the journal handed back. The closure itself is
   * never serialized; its VERDICT is journaled as a lowered `<step>.gate`
   * deterministic step that succeeds or fails, so resume and replay read the
   * recorded verdict and never re-run the function. A false verdict fails the
   * run as `gate_failed`, carrying `because`. `flows check` cannot prove a
   * predicate (docs/SURFACE.md §6); use a `NamedGate` when the check must be
   * inspectable before execution. One `.gate()` per step.
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
  | RegexMatchNamedGate
  | ArtifactExistsNamedGate;

/**
 * Passes when the step's journaled `artifacts` lists `path` — a file the
 * agent's worker measured as created or changed under its working directory.
 * The check reads the journal, so replay and resume see the verdict that was
 * recorded, never a fresh look at the disk.
 */
export interface ArtifactExistsNamedGate {
  type: 'artifact_exists';
  /** Working-directory-relative POSIX path, e.g. `review/security.md`. */
  path: string;
}

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
