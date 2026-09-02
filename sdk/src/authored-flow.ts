import {
  getFlowDefinition,
  type AuthoredFlowDefinition,
  type FlowHandle,
} from '@relayflows/surface/runtime';

/**
 * Recover the immutable program retained by an authored flow handle.
 *
 * Importing the module evaluates author code only far enough to define the
 * flow. A runner must inject a journal-backed context before invoking `body`;
 * this bridge never constructs a context or performs an effect itself.
 */
export function getAuthoredFlowDefinition(
  handle: FlowHandle,
): AuthoredFlowDefinition {
  return getFlowDefinition(handle);
}

export type { AuthoredFlowDefinition, FlowHandle };
