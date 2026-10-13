import { randomUUID } from 'node:crypto';
import type { AgentOptions, AgentResult, NamedGate } from '@relayflows/surface';
import { parseAgentStepTimeout } from './compile.js';
import type { StepSpec } from './spec.js';
import { BROKER_TYPE, brokerAgentName, brokerOptionsError, type BrokerInstruction } from './communication/broker-spec.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

type Declaration = { instruction: BrokerInstruction; cli?: string; model?: string };

/** Broker options stay in a journaled instruction; the kernel only sees agent steps. */
export function authoredBroker(definition: { name: string }, rootRunId: string | undefined,
  localStream: string | undefined, run: (step: StepSpec) => Promise<unknown>) {
  const owner = rootRunId ?? randomUUID();
  const declarations = new Map<string, Declaration>();
  const invalid = (message: string): never => { throw new AuthoredFlowExecutionError('agent_cli_unresolved', message); };
  const execute = async (id: string, declaration: Declaration, verification?: NamedGate): Promise<AgentResult> => {
    const { instruction, cli, model } = declaration;
    const output = await run({ id, type: 'agent', instruction: JSON.stringify(instruction), cli, model,
      timeoutMs: instruction.timeoutMs,
      // Retained sessions must return to the same worker, including after a child completes.
      surfaces: localStream === undefined ? undefined : { streams: [{ stream: localStream }] },
      maxIterations: 1, transportRetries: 0, verification });
    if (!output || typeof output !== 'object' || !('completionReason' in output)) {
      throw new AuthoredFlowExecutionError('journal_protocol_violation', 'Broker step produced an invalid result');
    }
    return output as AgentResult;
  };
  const lookup = (name: string): Declaration => declarations.get(name) ?? invalid(`No retained broker agent named ${name} in this flow`);
  return {
    async agent(id: string, name: string, options: AgentOptions, verification?: NamedGate): Promise<AgentResult> {
      const problem = brokerOptionsError(options);
      if (problem) invalid(`f.agent options: ${problem}`);
      if (options.keepAlive && localStream === undefined) invalid('Retained broker agents require a local agent worker stream');
      if (options.keepAlive && verification !== undefined) invalid('Retained broker agents do not support gates; validate their result in a later step');
      if (typeof options.task !== 'string' || !options.task.trim()) invalid('f.agent task must be nonempty');
      if (options.workspace !== undefined || options.permissions !== undefined) invalid('Broker agents use cwd; workspace and permissions are not supported');
      if ((options.maxIterations ?? 1) !== 1 || (options.transportRetries ?? 0) !== 0
        || options.recoveryMode !== undefined) invalid('Broker sessions require maxIterations 1, transportRetries 0, and no recoveryMode');
      if (typeof name !== 'string' || !name.trim()) invalid('Broker agent name must be nonempty');
      const instruction: BrokerInstruction = { type: BROKER_TYPE, operation: 'spawn', owner,
        flow: definition.name, step: name, agentName: brokerAgentName(definition.name, name, owner, id),
        task: options.task, cwd: options.cwd, skills: options.skills ?? [],
        channel: options.channel ?? `flow-${owner}`, keepAlive: options.keepAlive ?? false,
        timeoutMs: options.timeout === undefined ? 3_600_000 : parseAgentStepTimeout(options.timeout) };
      const declaration = { instruction, cli: options.cli, model: options.model };
      const result = await execute(id, declaration, verification);
      if (instruction.keepAlive && result.completionReason === 'success') declarations.set(instruction.agentName, declaration);
      return result;
    },
    async message(id: string, name: string, text: string, options?: { timeout?: string | number }): Promise<AgentResult> {
      const declaration = lookup(name);
      if (typeof text !== 'string' || !text.trim()) invalid('f.message text must be nonempty');
      const result = await execute(id, { ...declaration, instruction: { ...declaration.instruction,
        operation: 'message', task: text, timeoutMs: options?.timeout === undefined
          ? declaration.instruction.timeoutMs : parseAgentStepTimeout(options.timeout) } });
      return result;
    },
    async release(id: string, name: string): Promise<void> {
      const declaration = lookup(name);
      await run({ id, type: 'agent', cli: declaration.cli, model: declaration.model,
        instruction: JSON.stringify({ ...declaration.instruction, operation: 'release' }),
        surfaces: localStream === undefined ? undefined : { streams: [{ stream: localStream }] },
        maxIterations: 1, transportRetries: 0 });
      // Keep the declaration so an explicit release remains idempotent.
    },
  };
}
