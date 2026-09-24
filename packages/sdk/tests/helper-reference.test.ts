import { describe, expect, it } from 'vitest';
import { preflightHelpers } from '../src/preflight.js';
import { flowRequirements } from '../src/flow-requirements.js';
import { flow } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';

/**
 * A helper NAMED in a string or a comment is not a helper USED. Reading the
 * body as text refused flows for mounts they never touch — a shell command
 * echoing `f.gitlab`, an agent prompt naming `f.slack`, a PR title in a commit
 * message. Both readers (preflight and requirements) must read it as syntax.
 */
const mountFacts = { providers: {} as Record<string, { mount: boolean; mock: boolean; token?: string }> };
const refusals = (body: Function): string[] =>
  preflightHelpers({ header: {}, body }, mountFacts).diagnostics
    .filter((d) => d.severity === 'refusal')
    .map((d) => d.kind);

describe('helper references are read as syntax, not text', () => {
  it('does not demand a mount for a helper named inside a string', () => {
    expect(refusals(async (f: any) => { await f.run('echo f.gitlab'); })).toEqual([]);
    expect(refusals(async (f: any) => { await f.run('echo f.github'); })).toEqual([]);
  });

  it('does not demand a mount for a helper named in an agent prompt', () => {
    expect(refusals(async (f: any) => {
      await f.agent('a', { cli: 'claude', task: 'explain how f.slack.post works' });
    })).toEqual([]);
  });

  it('does not demand a mount for a helper named in a comment', () => {
    expect(refusals(async (f: any) => {
      // f.gitlab.issues.list is deliberately only mentioned here
      await f.run('true');
    })).toEqual([]);
  });

  it('still demands a mount for real dot access', () => {
    expect(refusals(async (f: any) => { await f.gitlab.issues.list({}); }))
      .toContain('helper_provider.mount_required');
  });

  it('still demands a mount for real bracket access', () => {
    expect(refusals(async (f: any) => { await f['gitlab'].issues.list({}); }))
      .toContain('helper_provider.mount_required');
  });

  it('does not declare a requirement from a mentioned helper', () => {
    const mentioned = getFlowDefinition(flow('mention', async (ctx: any) => {
      await ctx.run('echo f.gitlab');
    }));
    expect(flowRequirements(mentioned).integrations.map((i) => i.provider)).not.toContain('gitlab');

    const used = getFlowDefinition(flow('use', async (ctx: any) => {
      await ctx.gitlab.issues.list({});
    }));
    expect(flowRequirements(used).integrations.map((i) => i.provider)).toContain('gitlab');
  });
});
