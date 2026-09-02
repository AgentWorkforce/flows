/** A journal-backed step result with its postfix verification gate. */
export interface Step<T> extends PromiseLike<T> {
  /** Fail the step with `verification_failed` when the predicate is false. */
  gate(predicate: (value: T) => boolean, because?: string): Step<T>;
}
