import type {
  CliAdapterIdentification,
  CliInvocation,
  HeadlessAdapter,
  ModelProbeFailure,
} from './base.js';
import { providerUsageLimited } from './usage-limit.js';

const MODEL_PROBE_PROMPT = 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.';

/** OpenAI Codex CLI headless contract. Behavior identical to the pre-#141
 *  inline shape in `cli-adapter.ts` — only the packaging changed. */
export const codexAdapter: HeadlessAdapter = {
  kind: 'codex',

  buildIdentification(): CliAdapterIdentification {
    return { invocation: { args: ['login', 'status', '--help'], timeoutMs: 10_000 } };
  },

  buildAuthProbe(): CliInvocation {
    return { args: ['login', 'status'], timeoutMs: 10_000 };
  },

  buildModelReadinessProbe(model: string): CliInvocation {
    return {
      args: [
        'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--model', model, MODEL_PROBE_PROMPT,
      ],
      timeoutMs: 60_000,
    };
  },

  classifyModelProbeFailure(output: string): ModelProbeFailure | undefined {
    return providerUsageLimited(output) ? { cause: 'provider_usage_limited' } : undefined;
  },

  buildAgentInvocation(instruction: string, model?: string): CliInvocation {
    return {
      args: [
        // Real steps must retain Codex's native session under CODEX_HOME (or
        // ~/.codex). Hosted Relayflow teardown captures that provider history
        // and uploads it to Relayhistory; --ephemeral silently leaves nothing
        // for the bounded flush to capture. Readiness probes above stay
        // ephemeral because they are diagnostics, not workflow steps.
        'exec', '--skip-git-repo-check',
        // Agent-mode is where the flow explicitly delegates code changes to
        // the CLI. Without this flag codex prompts for approval on every
        // write, gets nothing (no TTY), and completes "successfully" without
        // touching files — the dogfood no-op failure mode. LLM-mode stays
        // read-only and does NOT get the bypass.
        '--dangerously-bypass-approvals-and-sandbox',
        ...(model === undefined ? [] : ['--model', model]),
        instruction,
      ],
      timeoutMs: 0,
    };
  },

  buildLlmInvocation(prompt: string, model?: string): CliInvocation {
    return {
      args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check',
        ...(model === undefined ? [] : ['--model', model]), prompt],
      timeoutMs: 0,
    };
  },
};
