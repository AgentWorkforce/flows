import type {
  CliAdapterIdentification,
  CliInvocation,
  HeadlessAdapter,
} from './base.js';

/**
 * `relayflows-adapter-v1` identifies a per-flow wrapper script — the pre-#141
 * per-flow shim shape. The wrapper answers a probe with a known token; agent
 * and llm execution flow through `runWrapperSession`, so this adapter refuses
 * to construct a direct-argv invocation for them.
 */
export const WRAPPER_IDENTIFY_ARG = '--relayflows-adapter-v1';
export const WRAPPER_IDENTIFY_TOKEN = 'relayflows-agent-cli-v1';
export const WRAPPER_EXECUTE_TOKEN = 'relayflows-agent-cli-v1-execute';

export const wrapperAdapter: HeadlessAdapter = {
  kind: 'relayflows-wrapper-v1',

  buildIdentification(): CliAdapterIdentification {
    return {
      invocation: { args: [WRAPPER_IDENTIFY_ARG], timeoutMs: 10_000 },
      expectedStdout: WRAPPER_IDENTIFY_TOKEN,
    };
  },

  buildAuthProbe(): CliInvocation {
    return { args: ['auth', 'status'], timeoutMs: 10_000 };
  },

  buildModelReadinessProbe(model: string): CliInvocation {
    return { args: ['auth', 'status'], timeoutMs: 60_000, modelEnv: model };
  },

  buildAgentInvocation(): CliInvocation {
    throw new Error('custom wrapper execution requires the runAgentCli same-process session');
  },

  buildLlmInvocation(): CliInvocation {
    throw new Error('custom wrapper execution requires the same-process session');
  },
};
