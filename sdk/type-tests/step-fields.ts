import type {
  AgentStepSpec,
  BaseStepSpec,
  DeterministicStepSpec,
  LlmStepSpec,
  StepType,
} from '../src/index.js';
import { STEP_COMMON_FIELDS, STEP_FIELDS_BY_TYPE } from '../src/step-fields.js';

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;

type _TimeoutIsNotCommon = Assert<Equal<Extract<keyof BaseStepSpec, 'timeoutMs'>, never>>;

const deterministic = {
  id: 'deterministic',
  type: 'deterministic',
  command: 'true',
  timeoutMs: 1_000,
} satisfies DeterministicStepSpec;

const llm = {
  id: 'llm',
  type: 'llm',
  prompt: 'answer',
  // @ts-expect-error timeoutMs is a deterministic-step-only authoring field.
  timeoutMs: 1_000,
} satisfies LlmStepSpec;

const agent = {
  id: 'agent',
  type: 'agent',
  instruction: 'act',
  // @ts-expect-error timeoutMs is a deterministic-step-only authoring field.
  timeoutMs: 1_000,
} satisfies AgentStepSpec;

void deterministic;
void llm;
void agent;

// --- the descriptor must not drift from the spec interfaces -----------------
//
// `STEP_FIELDS_BY_TYPE` is the only allowlist `validateSpec` consults, but it
// is a plain string table: `satisfies Record<StepType, readonly string[]>`
// checks the *shape*, not that it agrees with LlmStepSpec / AgentStepSpec.
// A field added to an interface but not to the table is therefore refused at
// runtime as an unknown key, with nothing failing at compile time — exactly
// how main's `output` sugar was nearly dropped when this branch moved the
// allowlist out of validate.ts. These assertions bind the two together.

type CommonField = typeof STEP_COMMON_FIELDS[number] | 'type';
/** Authoring fields an interface declares, minus the ones every verb shares. */
type VerbFields<Spec> = Exclude<keyof Spec, CommonField>;
/** Fields the descriptor lists for a verb. */
type DescribedFields<T extends StepType> = typeof STEP_FIELDS_BY_TYPE[T][number];

type _DeterministicIsDescribed =
  Assert<Equal<Exclude<VerbFields<DeterministicStepSpec>, DescribedFields<'deterministic'>>, never>>;
type _LlmIsDescribed =
  Assert<Equal<Exclude<VerbFields<LlmStepSpec>, DescribedFields<'llm'>>, never>>;
type _AgentIsDescribed =
  Assert<Equal<Exclude<VerbFields<AgentStepSpec>, DescribedFields<'agent'>>, never>>;

// ...and nothing is described that the interface does not declare.
type _DeterministicDescribesNothingExtra =
  Assert<Equal<Exclude<DescribedFields<'deterministic'>, VerbFields<DeterministicStepSpec>>, never>>;
type _LlmDescribesNothingExtra =
  Assert<Equal<Exclude<DescribedFields<'llm'>, VerbFields<LlmStepSpec>>, never>>;
type _AgentDescribesNothingExtra =
  Assert<Equal<Exclude<DescribedFields<'agent'>, VerbFields<AgentStepSpec>>, never>>;
