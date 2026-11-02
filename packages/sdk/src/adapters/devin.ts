import type { HeadlessAdapter } from './base.js';

const flags = ['-p', '--respect-workspace-trust', 'false'];

/** Devin print mode returns plain text; it has no JSON-output switch. */
export const devinAdapter: HeadlessAdapter = {
  kind: 'devin',
  buildIdentification: () => ({ invocation: { args: ['auth', 'status', '--help'], timeoutMs: 10_000 } }),
  // `auth status` exits zero even when logged out. Listing models actually
  // contacts the provider and refuses missing or invalid credentials.
  buildAuthProbe: () => ({ args: ['models', 'list', '--format', 'json'], timeoutMs: 30_000 }),
  buildModelReadinessProbe: model => ({
    args: [...flags, '--model', model, '--', 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.'],
    timeoutMs: 60_000,
  }),
  buildAgentInvocation: (instruction, model) => ({
    args: [...flags, '--permission-mode', 'dangerous', ...(model === undefined ? [] : ['--model', model])],
    promptFile: instruction,
    timeoutMs: 0,
  }),
  buildLlmInvocation: () => { throw new Error('Devin supports agent steps only; use a model provider for llm steps.'); },
};
