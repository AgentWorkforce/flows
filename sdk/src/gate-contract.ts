import type { StepSpec, VerificationSpec } from './spec.js';

export type JournalGateCheck =
  | 'completion'
  | 'exit_code'
  | 'output_contains'
  | 'json_schema';

export type AuthorGatePredicate<T> = (value: T) => boolean;
export type AuthorGate<T> = VerificationSpec | AuthorGatePredicate<T>;

export interface DataGateClassification {
  kind: 'data';
  checks: JournalGateCheck[];
  evaluator: 'kernel';
  preflightable: true;
  replayable: true;
}

export interface CodeGateClassification {
  kind: 'code';
  evaluator: 'author_runtime';
  preflightable: false;
  replayable: false;
}

export type GateClassification = DataGateClassification | CodeGateClassification;

export interface StepGateInspection extends DataGateClassification {
  stepId: string;
}

/**
 * Classify, but never serialize, a postfix gate argument.
 *
 * Named verification objects are spec data: `flows check` can validate their
 * shape, the kernel evaluates them, and the journal replays their verdict.
 * Functions are arbitrary author code. A TypeScript runtime may execute one,
 * but neither preflight nor the journal can reconstruct or prove the closure.
 */
export function classifyGate<T>(gate: AuthorGate<T>): GateClassification {
  if (typeof gate === 'function') {
    return {
      kind: 'code',
      evaluator: 'author_runtime',
      preflightable: false,
      replayable: false,
    };
  }
  return {
    kind: 'data',
    checks: [gate.type],
    evaluator: 'kernel',
    preflightable: true,
    replayable: true,
  };
}

/** Describe the exact named checks the existing kernel applies to a step. */
export function inspectStepGate(step: StepSpec): StepGateInspection {
  const checks: JournalGateCheck[] = [];
  if (step.type === 'deterministic') checks.push('exit_code');
  if (step.verification?.type === 'output_contains') checks.push('output_contains');
  if (step.verification?.type === 'json_schema') checks.push('json_schema');
  if (checks.length === 0) checks.push('completion');
  return {
    stepId: step.id,
    kind: 'data',
    checks,
    evaluator: 'kernel',
    preflightable: true,
    replayable: true,
  };
}
