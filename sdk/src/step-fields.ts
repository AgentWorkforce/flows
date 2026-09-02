import type { StepType } from './spec.js';

/** Closed top-level authoring schema, including named agent declarations. */
export const FLOW_FIELDS = [
  'version',
  'name',
  'description',
  'cli',
  'agents',
  'triggers',
  'steps',
  'budget',
] as const;

/** Closed named-agent declaration schema. */
export const AGENT_DECLARATION_FIELDS = ['cli', 'model'] as const;

/** Fields shared by every authoring step, regardless of its verb. */
export const STEP_COMMON_FIELDS = [
  'id',
  'type',
  'dependsOn',
  'verification',
  'maxIterations',
  'timeoutMs',
] as const;

/**
 * Closed verb-specific authoring schema (RFC-0001 decision 13). Validation
 * consumes this descriptor directly so a new optional field cannot bypass the
 * per-verb boundary through a second, drifting allowlist.
 */
export const STEP_FIELDS_BY_TYPE = {
  deterministic: ['command'],
  llm: ['prompt', 'model', 'cli'],
  agent: ['instruction', 'agent', 'cli', 'model', 'surfaces', 'recoveryMode', 'permissions'],
} as const satisfies Record<StepType, readonly string[]>;
