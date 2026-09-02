import {
  getFlowDefinition,
  type AuthoredFlowDefinition,
  type FlowHandle,
} from '@relayflows/surface/runtime';

/**
 * Recover the immutable program retained by an authored flow handle.
 *
 * Importing the module evaluates author code only far enough to define the
 * flow. `executeAuthoredFlow` owns the initial journal-backed context; callers
 * that only need inspection can recover the definition without executing it.
 */
export function getAuthoredFlowDefinition<Input = unknown>(
  handle: FlowHandle,
): AuthoredFlowDefinition<Input> {
  return getFlowDefinition<Input>(handle);
}

export type { AuthoredFlowDefinition, FlowHandle };
