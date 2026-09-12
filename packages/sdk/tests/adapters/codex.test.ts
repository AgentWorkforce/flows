import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../../src/adapters/codex.js';

describe('codexAdapter — HeadlessAdapter contract', () => {
  it('identifies itself as kind "codex"', () => {
    expect(codexAdapter.kind).toBe('codex');
  });

  it('buildIdentification uses login-status help', () => {
    const id = codexAdapter.buildIdentification();
    expect(id.invocation.args).toEqual(['login', 'status', '--help']);
    expect(id.expectedStdout).toBeUndefined();
  });

  it('buildAuthProbe is login-status', () => {
    expect(codexAdapter.buildAuthProbe().args).toEqual(['login', 'status']);
  });

  it('buildModelReadinessProbe runs in ephemeral read-only exec with --model', () => {
    const inv = codexAdapter.buildModelReadinessProbe('gpt-6-astra');
    expect(inv.args[0]).toBe('exec');
    expect(inv.args).toContain('--ephemeral');
    expect(inv.args).toContain('--sandbox');
    expect(inv.args).toContain('read-only');
    expect(inv.args).toContain('--skip-git-repo-check');
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('gpt-6-astra');
  });

  it('buildAgentInvocation uses exec --ephemeral --skip-git-repo-check with instruction at the tail', () => {
    const inv = codexAdapter.buildAgentInvocation('build the thing', 'gpt-6-astra');
    expect(inv.args[0]).toBe('exec');
    expect(inv.args).toContain('--ephemeral');
    expect(inv.args).toContain('--skip-git-repo-check');
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('gpt-6-astra');
    expect(inv.args.at(-1)).toBe('build the thing');
    expect(inv.timeoutMs).toBe(0);
  });

  it('buildAgentInvocation omits --model when unset and never adds --sandbox to agent execution', () => {
    const inv = codexAdapter.buildAgentInvocation('build the thing');
    expect(inv.args).not.toContain('--model');
    expect(inv.args).not.toContain('--sandbox');
  });

  it('buildLlmInvocation adds --sandbox read-only', () => {
    const inv = codexAdapter.buildLlmInvocation('summarize');
    expect(inv.args).toContain('--sandbox');
    expect(inv.args).toContain('read-only');
  });
});
