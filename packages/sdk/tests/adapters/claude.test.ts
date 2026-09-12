import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude.js';

describe('claudeAdapter — HeadlessAdapter contract', () => {
  it('identifies itself as kind "claude"', () => {
    expect(claudeAdapter.kind).toBe('claude');
  });

  it('buildIdentification uses the auth-status help shape', () => {
    const id = claudeAdapter.buildIdentification();
    expect(id.invocation.args).toEqual(['auth', 'status', '--help']);
    expect(id.invocation.timeoutMs).toBeGreaterThan(0);
    expect(id.expectedStdout).toBeUndefined();
  });

  it('buildAuthProbe is a non-interactive auth-status', () => {
    expect(claudeAdapter.buildAuthProbe().args).toEqual(['auth', 'status']);
  });

  it('buildModelReadinessProbe passes the model via --model and forbids tools + session persistence', () => {
    const inv = claudeAdapter.buildModelReadinessProbe('opus-4-x');
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('opus-4-x');
    expect(inv.args).toContain('--tools');
    expect(inv.args).toContain('--no-session-persistence');
  });

  it('buildAgentInvocation ends with the instruction and lets timeouts stay unbounded', () => {
    const inv = claudeAdapter.buildAgentInvocation('write a haiku', 'opus-4-x');
    expect(inv.args[0]).toBe('-p');
    expect(inv.args.at(-1)).toBe('write a haiku');
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('opus-4-x');
    expect(inv.timeoutMs).toBe(0);
  });

  it('buildAgentInvocation omits --model when no model is provided', () => {
    const inv = claudeAdapter.buildAgentInvocation('write a haiku');
    expect(inv.args).not.toContain('--model');
    expect(inv.args.at(-1)).toBe('write a haiku');
  });

  it('buildLlmInvocation matches the non-agent shape (no tools, no session persistence)', () => {
    const inv = claudeAdapter.buildLlmInvocation('summarize', 'opus-4-x');
    expect(inv.args).toContain('--tools');
    expect(inv.args).toContain('--no-session-persistence');
    expect(inv.args).toContain('--model');
    expect(inv.args.at(-1)).toBe('summarize');
  });
});
