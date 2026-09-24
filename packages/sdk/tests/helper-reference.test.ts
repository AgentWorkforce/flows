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
const fromSource = (source: string): Function => new Function(`return ${source};`)() as Function;

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

  // The context parameter is compared to an AST Identifier name, so escaping
  // it for a regex (as the pre-parser code did) hid every call in the flow.
  it('sees helpers when the context parameter contains a regex metacharacter', () => {
    expect(refusals(async (f$: any) => { await f$.gitlab.issues.list({}); }))
      .toContain('helper_provider.mount_required');
  });

  // `parseExpressionAt` stops at the first expression without objecting to the
  // rest, so a method body parsed as the identifier `async` and declared
  // nothing. Every attempt must consume the whole source.
  it('sees helpers in an object-literal method body', () => {
    const holder = { async post(f: any) { await f.gitlab.issues.list({}); } };
    expect(refusals(holder.post)).toContain('helper_provider.mount_required');
  });

  it('sees helpers in non-async and generator method bodies', () => {
    const holder = {
      plain(f: any) { return f.gitlab.issues.list({}); },
      *gen(f: any) { return f.gitlab.issues.list({}); },
    };
    expect(refusals(holder.plain)).toContain('helper_provider.mount_required');
    expect(refusals(holder.gen as never)).toContain('helper_provider.mount_required');
  });

  it('does not treat destructured locals as the outer flow context', () => {
    for (const source of [
      '(f) => { { const { f } = { f: { gitlab: { issues: 42 } } }; return f.gitlab.issues; } }',
      '(f) => { { const [f] = [{ gitlab: { issues: 42 } }]; return f.gitlab.issues; } }',
    ]) expect(refusals(fromSource(source)), source).toEqual([]);
  });

  it('does not treat object or class method parameters as the outer flow context', () => {
    for (const source of [
      '(f) => ({ read(f) { return f.gitlab.issues; } }).read({ gitlab: { issues: 42 } })',
      '(f) => new class { read(f) { return f.gitlab.issues; } }().read({ gitlab: { issues: 42 } })',
      '(f) => ({ read({ f }) { return f.gitlab.issues; } }).read({ f: { gitlab: { issues: 42 } } })',
    ]) expect(refusals(fromSource(source)), source).toEqual([]);
  });

  it('keeps reading the outer context outside a shadowing scope', () => {
    const source = '(f) => { { const { f } = { f: { gitlab: {} } }; void f.gitlab; } return f.gitlab.issues; }';
    expect(refusals(fromSource(source))).toContain('helper_provider.mount_required');
    expect(refusals(fromSource('(f) => { if (f) return f.gitlab.issues; }')))
      .toContain('helper_provider.mount_required');
  });

  // `flowRequirements` has its OWN parameter extraction, mirroring
  // `preflightHelpers`. The shapes above are asserted through preflight, so
  // without these the mirrored regex could be reverted with the suite green.
  it('declares helpers for every body shape through flowRequirements too', () => {
    const providersFor = (body: unknown): string[] =>
      flowRequirements({ body } as never).integrations.map((i) => i.provider);
    const holder = {
      async asyncMethod(f: any) { return f.gitlab.issues.list({}); },
      plain(f: any) { return f.gitlab.issues.list({}); },
      *gen(f: any) { return f.gitlab.issues.list({}); },
    };
    expect(providersFor(holder.asyncMethod)).toContain('gitlab');
    expect(providersFor(holder.plain)).toContain('gitlab');
    expect(providersFor(holder.gen)).toContain('gitlab');
    expect(providersFor(async (f$: any) => { await f$.gitlab.issues.list({}); })).toContain('gitlab');
    expect(providersFor(async (f: any) => { await f.run('echo f.gitlab'); })).not.toContain('gitlab');
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
