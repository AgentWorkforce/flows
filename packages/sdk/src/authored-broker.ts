import type { AgentOptions, AgentResult, NamedGate } from '@relayflows/surface';
import type { StepSpec } from './spec.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

const RETIRED = 'transport: broker was removed with the Relay broker. Use transport: relay for one-shot fleet execution. '
  + 'Retained local sessions require an authorized Desktop service-caller contract and remain fail-closed.';

/** Compatibility boundary for authored flows compiled before broker retirement. */
export function authoredBroker(
  _definition: { name: string },
  _rootRunId: string | undefined,
  _localStream: string | undefined,
  _run: (step: StepSpec) => Promise<unknown>,
) {
  const refused = (): never => { throw new AuthoredFlowExecutionError('agent_cli_unresolved', RETIRED); };
  return {
    agent: async (_id: string, _name: string, _options: AgentOptions, _verification?: NamedGate,
      _secrets?: string[]): Promise<AgentResult> => refused(),
    message: async (_id: string, _name: string, _text: string, _options?: { timeout?: string | number },
      _verification?: NamedGate): Promise<AgentResult> => refused(),
    release: async (_id: string, _name: string): Promise<void> => refused(),
  };
}
