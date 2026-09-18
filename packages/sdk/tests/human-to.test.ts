import { flow } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import { describe, expect, it } from 'vitest';
import { flowRequirements } from '../src/flow-requirements.js';
import { humanRecipientProvider, parseHumanRecipient, parseHumanTo } from '../src/human-to.js';

describe('parseHumanRecipient', () => {
  it('reads the four documented forms', () => {
    expect(parseHumanRecipient('slack:#eng')).toEqual({ provider: 'slack', kind: 'channel', target: 'eng' });
    expect(parseHumanRecipient('slack:@khaliq')).toEqual({ provider: 'slack', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('slack: khaliq')).toEqual({ provider: 'slack', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('github:@khaliq')).toEqual({ provider: 'github', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('khaliq')).toEqual({ provider: 'approver', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('@khaliq')).toEqual({ provider: 'approver', kind: 'user', target: 'khaliq' });
  });

  it('refuses malformed forms with a reason instead of making them delivery targets', () => {
    const bad: [string, RegExp][] = [
      ['', /empty/u],
      ['   ', /empty/u],
      ['slack:', /names no channel or user/u],
      ['slack:#', /not a Slack channel name/u],
      ['github:', /names no user/u],
      ['github:#eng', /GitHub has no channels/u],
      ['email:khaliq', /not a delivery provider/u],
      ['slack:@two words', /not a Slack handle/u],
      ['slack:@"quoted"', /not a Slack handle/u],
      ['two words', /not a handle/u],
      ['@', /not a handle/u],
      ['slack:@', /not a Slack handle/u],
    ];
    for (const [to, reason] of bad) {
      const parsed = parseHumanTo(to);
      expect(parsed.ok, to).toBe(false);
      if (!parsed.ok) expect(parsed.reason, to).toMatch(reason);
      expect(humanRecipientProvider(to), to).toBeUndefined();
      expect(() => parseHumanRecipient(to), to).toThrow(/f\.human to/u);
    }
    expect(parseHumanTo('SLACK:#Eng')).toEqual({ ok: true, recipient: { provider: 'slack', kind: 'channel', target: 'Eng' } });
    expect(parseHumanTo('github:@octo-cat.dev')).toEqual({ ok: true, recipient: { provider: 'github', kind: 'user', target: 'octo-cat.dev' } });
  });

  it('names the integration a recipient needs, and none for the approver', () => {
    expect(humanRecipientProvider('slack:#eng')).toBe('slack');
    expect(humanRecipientProvider('github:@k')).toBe('github');
    expect(humanRecipientProvider('khaliq')).toBeUndefined();
  });
});

describe('flowRequirements reads f.human to', () => {
  it('requires the delivery provider of a literal to, once, as f.human to', () => {
    const definition = getFlowDefinition(flow('ship', async (f) => {
      const ok = await f.human('Ship?', { to: 'slack:#releases' });
      if (!ok) return f.done('declined');
      await f.human('Really?', { to: 'slack:@khaliq' });
      f.done('success');
    }));
    expect(flowRequirements(definition).integrations).toEqual([
      { provider: 'slack', from: 'human', detail: 'f.human to' },
    ]);
  });

  it('does not require a provider for a bare approver or a computed to', () => {
    const definition = getFlowDefinition(flow<{ approver: string }>('ship', async (f, input) => {
      await f.human('Ship?', { to: input.approver });
      await f.human('Again?', { to: 'khaliq' });
      f.done('success');
    }));
    expect(flowRequirements(definition).integrations).toEqual([]);
  });

  it('reads each call\'s own `to` only: never a later call, a nested object, the question text, or unrelated code', () => {
    const definition = getFlowDefinition(flow<{ approver: string }>('ship', async (f, input) => {
      const route = { to: 'github:@decoy-object', from: 'x' };
      void route;
      const first = await f.human('Send this to: "slack:#decoy-in-question"?', { note: { to: 'github:@nested' }, to: 'slack:#releases' });
      void first;
      const second = await f.human('Again?', { to: input.approver });
      void second;
      const third = await f.human(`Really ${String(input.approver)}?`, { to: `slack:@${input.approver}` });
      void third;
      const fourth = await f.human('Last?', {
        to: 'khaliq',
      });
      void fourth;
      await f.human('Malformed?', { to: 'email:nobody' });
      f.done('success');
    }));
    // The decoy object, the `to:` inside the question string, the nested
    // `note.to`, the computed and template recipients, and the malformed one
    // contribute nothing; the two literal recipients are read from their own calls.
    expect(flowRequirements(definition).integrations).toEqual([
      { provider: 'slack', from: 'human', detail: 'f.human to' },
    ]);
    const githubOnly = getFlowDefinition(flow('ship', async (f) => {
      const cfg = { to: 'slack:#not-mine' };
      void cfg;
      await f.human('Ship (to: "slack:#in-text")?', { to: 'github:@khaliq' });
      f.done('success');
    }));
    expect(flowRequirements(githubOnly).integrations).toEqual([
      { provider: 'github', from: 'human', detail: 'f.human to' },
    ]);
  });

  it('ignores commas, brackets and `to:` inside comments on the call itself', () => {
    const definition = getFlowDefinition(flow('ship', async (f) => {
      // The bodies below keep their comments: Function.prototype.toString
      // preserves them, so the scanner meets them as text.
      await f.human(
        'Ship?', // to: "github:@in-line-comment", { extra: 1 },
        /* to: 'slack:#in-block-comment', */ { to: 'slack:#releases' /* , to: "github:@trailing" */ },
      );
      await f.human('Again?', {
        // to: "github:@commented-property",
        to: 'slack:@khaliq',
      });
      f.done('success');
    }));
    expect(flowRequirements(definition).integrations).toEqual([
      { provider: 'slack', from: 'human', detail: 'f.human to' },
    ]);
    const commentedOut = getFlowDefinition(flow('ship', async (f) => {
      await f.human('Ship?', {
        // to: "slack:#no",
        to: 'github:@khaliq',
      });
      f.done('success');
    }));
    expect(flowRequirements(commentedOut).integrations).toEqual([
      { provider: 'github', from: 'human', detail: 'f.human to' },
    ]);
  });

  it('keeps a helper requirement the body already declares ahead of f.human', () => {
    const definition = getFlowDefinition(flow('ship', async (f) => {
      await f.slack.post('#eng', 'hi');
      await f.human('Ship?', { to: 'github:@khaliq' });
      f.done('success');
    }));
    expect(flowRequirements(definition).integrations).toEqual([
      { provider: 'slack', from: 'helper', detail: 'f.slack' },
      { provider: 'github', from: 'human', detail: 'f.human to' },
    ]);
  });
});
