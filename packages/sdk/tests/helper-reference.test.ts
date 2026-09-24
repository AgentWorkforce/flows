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

  // A template quasi is text; a `${…}` is live code. Blanking the whole
  // template hid real helper calls — a flow deploying without its mount and
  // failing at runtime, which is worse than the false refusal this fixes.
  it('sees a helper called from a template interpolation', () => {
    expect(refusals(async (f: any) => { await f.run(`echo ${await f.gitlab.issues.list({})}`); }))
      .toContain('helper_provider.mount_required');
  });

  it('sees a helper called from a nested template interpolation', () => {
    expect(refusals(async (f: any) => { await f.run(`a ${`b ${await f.gitlab.issues.list({})}`}`); }))
      .toContain('helper_provider.mount_required');
  });

  it('does not demand a mount for a helper named in template TEXT', () => {
    expect(refusals(async (f: any) => { await f.run(`echo f.gitlab now`); })).toEqual([]);
  });

  // A regex is not code: `/f.gitlab/` is a mention, and a quote inside one
  // would otherwise open a phantom string and blank the rest of the body.
  it('does not read a helper named inside a regex literal as use', () => {
    expect(refusals(async (f: any) => { const p = /f.gitlab/; await f.run('true'); return p; })).toEqual([]);
  });

  it('still sees a real helper call after a regex containing a quote', () => {
    expect(refusals(async (f: any) => { const a = /'/; await f.gitlab.issues.list({}); return a; }))
      .toContain('helper_provider.mount_required');
  });

  it('does not mistake division for a regex', () => {
    expect(refusals(async (f: any) => { const n = 10 / 2; await f.run('true'); return n; })).toEqual([]);
  });

  // Shapes a lexer cannot settle. `/` is a regex or a division depending on
  // whether the previous token ends an expression, which needs parse context;
  // and the blanking version missed optional chaining outright, passing a
  // flow that really used the helper.
  it('sees a helper reached through optional chaining', () => {
    expect(refusals(async (f: any) => { await f?.gitlab?.issues.list({}); }))
      .toContain('helper_provider.mount_required');
  });

  it('sees a helper used inside a nested arrow', () => {
    expect(refusals(async (f: any) => {
      await Promise.all([1].map(async () => f.gitlab.issues.list({})));
    })).toContain('helper_provider.mount_required');
  });

  it('reads a regex after a closing paren as a regex, not division', () => {
    expect(refusals(async (f: any) => {
      if (String(1).match(/f.gitlab/)) { await f.run('x'); }
    })).toEqual([]);
  });

  it('reads division after a closing paren as division', () => {
    expect(refusals(async (f: any) => {
      const n = (1 + 2) / 2; await f.run('echo f.gitlab'); return n;
    })).toEqual([]);
  });

  it('does not treat a matching object key as helper use', () => {
    expect(refusals(async (f: any) => { const o = { gitlab: 1 }; await f.run('true'); return o; })).toEqual([]);
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
