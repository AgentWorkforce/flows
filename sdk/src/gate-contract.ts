import type { StepSpec } from './spec.js';

export type JournalGateCheck =
  | 'completion'
  | 'exit_code'
  | 'output_contains'
  | 'json_schema';

export interface DataGateClassification {
  kind: 'data';
  checks: JournalGateCheck[];
  evaluator: 'kernel';
  preflightable: true;
  replayable: true;
}

export interface StepGateInspection extends DataGateClassification {
  stepId: string;
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
