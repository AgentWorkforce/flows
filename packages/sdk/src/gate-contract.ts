import type { StepSpec } from './spec.js';
import { isNamedGate } from './named-gates.js';

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
  /**
   * Present only when the declared `json_schema` accepts every possible
   * output. `{}` and `true` are legal JSON Schema and the kernel accepts both,
   * so this is not a refusal — but a gate that judges nothing must not read
   * identically to a gate that judges something.
   */
  acceptsAnyOutput?: true;
}

/** Annotation-only keywords: present, they still constrain no instance. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$dynamicAnchor',
  '$id',
  '$schema',
  '$vocabulary',
  'default',
  'definitions',
  'deprecated',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

/** A schema that accepts every output: `true`, `{}`, or annotations only. */
export function acceptsAnyOutput(schema: unknown): boolean {
  if (schema === true) return true;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  return Object.keys(schema).every((key) => ANNOTATIONS.has(key));
}

/** Describe the exact named checks the existing kernel applies to a step. */
export function inspectStepGate(step: StepSpec): StepGateInspection {
  const checks: JournalGateCheck[] = [];
  if (isNamedGate(step.verification)) {
    checks.push('exit_code');
    if (step.verification.type === 'references_input') checks.push('output_contains');
    if (step.verification.type === 'word_count_bounds') checks.push('json_schema');
    return { stepId: step.id, kind: 'data', checks, evaluator: 'kernel', preflightable: true, replayable: true };
  }
  if (step.type === 'deterministic') checks.push('exit_code');
  if (step.verification?.type === 'output_contains') checks.push('output_contains');
  if (step.verification?.type === 'json_schema') checks.push('json_schema');
  if (checks.length === 0) checks.push('completion');
  const vacuous = step.verification?.type === 'json_schema'
    && acceptsAnyOutput(step.verification.schema);
  return {
    stepId: step.id,
    kind: 'data',
    checks,
    evaluator: 'kernel',
    preflightable: true,
    replayable: true,
    ...(vacuous ? { acceptsAnyOutput: true as const } : {}),
  };
}
