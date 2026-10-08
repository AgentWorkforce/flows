import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude.js';

describe('claudeAdapter — HeadlessAdapter contract', () => {
  it('identifies itself as kind "claude"', () => {
    expect(claudeAdapter.kind).toBe('claude');
    expect(claudeAdapter.defaultModel).toBe('claude-opus-5');
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

  // A task is author text, not an option: one that starts with `-` or `--`
  // must still reach the CLI as the prompt operand, after the separator.
  it.each(['-v', '--version', '--help me plan', '--', '-'])('passes a dash-leading task %j after the end-of-options separator', task => {
    for (const inv of [
      claudeAdapter.buildAgentInvocation(task, 'm'),
      claudeAdapter.buildAgentInvocation(task),
      claudeAdapter.buildLlmInvocation(task, 'm'),
      claudeAdapter.buildLlmInvocation(task),
    ]) {
      expect(inv.args.slice(-2)).toEqual(['--', task]);
      expect(inv.args.indexOf('--')).toBe(inv.args.length - 2);
    }
  });

  it('ends the readiness probe options before its prompt', () => {
    expect(claudeAdapter.buildModelReadinessProbe('m').args.at(-2)).toBe('--');
  });
});
