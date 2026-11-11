import type { FlowSpec, KernelRunSpec } from '../spec.js';
import { communicationInstruction } from './spec.js';

export class CommunicationEnvironmentError extends Error {}

/** Refuse before admission; no hidden fallback may restart the retired broker. */
export function checkCommunicationEnvironment(spec: FlowSpec | KernelRunSpec): void {
  if (!spec.steps.some(step => step.type === 'agent' && communicationInstruction(step.instruction))) return;
  throw new CommunicationEnvironmentError(
    'Agent communication through broker/PTy was removed. Native node-spawn communication requires the pending authorized local service-caller contract.',
  );
}
