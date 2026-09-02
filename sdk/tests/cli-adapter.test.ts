import { describe, expect, it } from 'vitest';
import {
  agentExecution,
  adapterIdentification,
  authenticationProbe,
  cliAdapterKind,
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
    expect(readiness).not.toHaveProperty('modelEnv');
    expect(agentExecution(kind, 'Review.', 'claude-model')).toEqual({
      args: ['-p', '--model', 'claude-model', 'Review.'],
      timeoutMs: 0,
    });
  });

  it('maps raw Codex to login status and noninteractive exec --model', () => {
    const kind = cliAdapterKind('/opt/bin/codex');

    expect(kind).toBe('codex');
    expect(adapterIdentification(kind).invocation.args).toEqual(['login', 'status', '--help']);
    expect(authenticationProbe(kind).args).toEqual(['login', 'status']);
    expect(modelReadinessProbe(kind, 'gpt-model')).toEqual({
      args: [
        'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--model', 'gpt-model', 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.',
      ],
      timeoutMs: 60_000,
    });
    expect(agentExecution(kind, 'Review.', 'gpt-model')).toEqual({
      args: ['exec', '--ephemeral', '--skip-git-repo-check', '--model', 'gpt-model', 'Review.'],
      timeoutMs: 0,
    });
  });

  it('requires custom executables to identify before using the wrapper env protocol', () => {
    const kind = cliAdapterKind('/project/bin/team-reviewer');

    expect(kind).toBe('relayflows-wrapper-v1');
    expect(adapterIdentification(kind).invocation.args).toEqual([WRAPPER_IDENTIFY_ARG]);
    expect(authenticationProbe(kind).args).toEqual(['auth', 'status']);
    expect(modelReadinessProbe(kind, 'team-model')).toMatchObject({
      args: ['auth', 'status'],
      modelEnv: 'team-model',
    });
    expect(agentExecution(kind, 'Review.', 'team-model')).toEqual({
      args: ['Review.'],
      timeoutMs: 0,
      modelEnv: 'team-model',
    });
  });
});
