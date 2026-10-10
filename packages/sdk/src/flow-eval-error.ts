export type FlowEvalErrorCode =
  | 'invalid_suite' | 'invalid_baseline' | 'version_mismatch' | 'suite_mismatch' | 'invalid_options' | 'unreadable_flow';

/** The evaluation itself is invalid. Case failures are verdicts in the report, never this. */
export class FlowEvalError extends Error {
  constructor(readonly code: FlowEvalErrorCode, message: string) {
    super(message);
    this.name = 'FlowEvalError';
  }
}
