import {
  getFlowDefinition,
  type AuthoredFlowDefinition,
  type FlowHandle,
} from '@relayflows/surface/runtime';

/**
 * Recover the immutable program retained by an authored flow handle.
 *
 * Importing the module evaluates author code only far enough to define the
 * flow. The SDK does not yet expose a public executor because authored-body
 * progress has no durable root journal. Internal lowering tests recover the
 * definition here without making that seam a supported runner.
 */
export function getAuthoredFlowDefinition(
  handle: FlowHandle,
): AuthoredFlowDefinition {
  return getFlowDefinition(handle);
}

export type { AuthoredFlowDefinition, FlowHandle };
