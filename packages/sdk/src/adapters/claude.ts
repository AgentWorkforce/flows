import type {
  CliAdapterIdentification,
  CliInvocation,
  HeadlessAdapter,
  ModelProbeFailure,
} from './base.js';
import { promptOperand } from './base.js';
import { providerUsageLimited } from './usage-limit.js';

const MODEL_PROBE_PROMPT = 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.';

/** Claude Code CLI headless contract. Wire and behavior identical to the
 *  pre-#141 inline shape in `cli-adapter.ts` — only the packaging changed. */
export const claudeAdapter: HeadlessAdapter = {
  kind: 'claude',
  defaultModel: 'claude-opus-5',

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
        ...promptOperand(MODEL_PROBE_PROMPT),
      ],
      timeoutMs: 60_000,
    };
  },

  classifyModelProbeFailure(output: string): ModelProbeFailure | undefined {
    // Checked first: an older Claude Code also prints its own
    // `unrecognized_model` catalog warning for a model newer than it, which
    // must not read as the model being unknown to the provider.
    const outdated = /does not support this model; version (\S+) or newer is required/.exec(output);
    if (outdated !== null) return { cause: 'cli_outdated', requiredVersion: outdated[1]! };
    if (providerUsageLimited(output)) return { cause: 'provider_usage_limited' };
    if (/issue with the selected model|not_found_error|may not exist or you may not have access/i.test(output)) {
      return { cause: 'model_unknown' };
    }
    return undefined;
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
        ...promptOperand(instruction),
      ],
      timeoutMs: 0,
    };
  },

  buildLlmInvocation(prompt: string, model?: string): CliInvocation {
    return {
      args: ['-p', '--tools', '', '--no-session-persistence',
        ...(model === undefined ? [] : ['--model', model]), ...promptOperand(prompt)],
      timeoutMs: 0,
    };
  },
};
