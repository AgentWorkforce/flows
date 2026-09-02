import type {
  AgentStepSpec,
  BaseStepSpec,
  DeterministicStepSpec,
  LlmStepSpec,
} from '../src/index.js';

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
