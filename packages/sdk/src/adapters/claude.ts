import type {
  CliAdapterIdentification,
  CliInvocation,
  HeadlessAdapter,
} from './base.js';

const MODEL_PROBE_PROMPT = 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.';

/** Claude Code CLI headless contract. Wire and behavior identical to the
 *  pre-#141 inline shape in `cli-adapter.ts` — only the packaging changed. */
export const claudeAdapter: HeadlessAdapter = {
  kind: 'claude',

  buildIdentification(): CliAdapterIdentification {
    return { invocation: { args: ['auth', 'status', '--help'], timeoutMs: 10_000 } };
  },

  buildAuthProbe(): CliInvocation {
    return { args: ['auth', 'status'], timeoutMs: 10_000 };
  },

  buildModelReadinessProbe(model: string): CliInvocation {
    return {
      args: [
        '-p', '--model', model, '--tools', '', '--no-session-persistence',
        MODEL_PROBE_PROMPT,
      ],
      timeoutMs: 60_000,
    };
  },

  buildAgentInvocation(instruction: string, model?: string): CliInvocation {
    return {
      args: [
        '-p',
        // Symmetric to codex's --dangerously-bypass-approvals-and-sandbox: in
        // agent mode the flow explicitly delegates writes. Without this
        // claude's headless mode prompts for tool approval, gets no TTY,
        // and completes "successfully" without touching files.
        '--dangerously-skip-permissions',
        ...(model === undefined ? [] : ['--model', model]),
        instruction,
      ],
      timeoutMs: 0,
    };
  },

  buildLlmInvocation(prompt: string, model?: string): CliInvocation {
    return {
      args: ['-p', '--tools', '', '--no-session-persistence',
        ...(model === undefined ? [] : ['--model', model]), prompt],
      timeoutMs: 0,
    };
  },
};
