import { describe, expect, it } from 'vitest';
import {
  agentExecution,
  adapterIdentification,
  authenticationProbe,
  cliAdapterKind,
  HEADLESS_PROMPT_FILE,
  modelReadinessProbe,
  WRAPPER_IDENTIFY_ARG,
} from '../src/cli-adapter.js';

describe('typed CLI adapters', () => {
  it('maps raw Claude to real auth, noninteractive, and model flag shapes', () => {
    const kind = cliAdapterKind('/usr/local/bin/claude');

    expect(kind).toBe('claude');
    expect(adapterIdentification(kind).invocation.args).toEqual(['auth', 'status', '--help']);
    expect(authenticationProbe(kind).args).toEqual(['auth', 'status']);
    const readiness = modelReadinessProbe(kind, 'claude-model');
    expect(readiness).toMatchObject({
      args: expect.arrayContaining(['-p', '--model', 'claude-model']),
    });
    expect(readiness.stdin).toContain('RELAYFLOWS_MODEL_READY');
    expect(readiness).not.toHaveProperty('modelEnv');
    expect(agentExecution(kind, 'Review.', 'claude-model')).toEqual({
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-model'],
      timeoutMs: 0,
      stdin: 'Review.',
    });
  });

  it('maps raw Codex to login status and noninteractive exec --model', () => {
    const kind = cliAdapterKind('/opt/bin/codex');

    expect(kind).toBe('codex');
    expect(adapterIdentification(kind).invocation.args).toEqual(['login', 'status', '--help']);
    expect(authenticationProbe(kind).args).toEqual(['login', 'status']);
    expect(modelReadinessProbe(kind, 'gpt-model')).toEqual({
      args: [
        'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--model', 'gpt-model', '-',
      ],
      timeoutMs: 60_000,
      stdin: 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.',
    });
    expect(agentExecution(kind, 'Review.', 'gpt-model')).toEqual({
      args: ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--model', 'gpt-model', '-'],
      timeoutMs: 0,
      stdin: 'Review.',
    });
  });

  it('requires custom executables to use the same-process wrapper session', () => {
    const kind = cliAdapterKind('/project/bin/team-reviewer');

    expect(kind).toBe('relayflows-wrapper-v1');
    expect(adapterIdentification(kind).invocation.args).toEqual([WRAPPER_IDENTIFY_ARG]);
    expect(authenticationProbe(kind).args).toEqual(['auth', 'status']);
    expect(modelReadinessProbe(kind, 'team-model')).toMatchObject({
      args: ['auth', 'status'],
      modelEnv: 'team-model',
    });
    expect(() => agentExecution(kind, 'Review.', 'team-model')).toThrow(
      'custom wrapper execution requires the runAgentCli same-process session',
    );
  });

  it('maps raw Grok to its prompt-file structured mode', () => {
    const kind = cliAdapterKind('/opt/bin/grok');

    expect(kind).toBe('grok');
    expect(adapterIdentification(kind).invocation.args).toEqual(['auth', 'status', '--help']);
    expect(authenticationProbe(kind).args).toEqual(['auth', 'status']);
    expect(agentExecution(kind, 'Review.', 'grok-model')).toEqual({
      args: ['--prompt-file', HEADLESS_PROMPT_FILE, '--output-format', 'json', '--model', 'grok-model'],
      timeoutMs: 0,
      promptFile: 'Review.',
    });
  });
});
