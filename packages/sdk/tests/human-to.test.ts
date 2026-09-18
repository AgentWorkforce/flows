import { flow } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import { describe, expect, it } from 'vitest';
import { flowRequirements } from '../src/flow-requirements.js';
import { humanRecipientProvider, parseHumanRecipient } from '../src/human-to.js';

describe('parseHumanRecipient', () => {
  it('reads the four documented forms', () => {
    expect(parseHumanRecipient('slack:#eng')).toEqual({ provider: 'slack', kind: 'channel', target: 'eng' });
    expect(parseHumanRecipient('slack:@khaliq')).toEqual({ provider: 'slack', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('slack: khaliq')).toEqual({ provider: 'slack', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('github:@khaliq')).toEqual({ provider: 'github', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('khaliq')).toEqual({ provider: 'approver', kind: 'user', target: 'khaliq' });
    expect(parseHumanRecipient('@khaliq')).toEqual({ provider: 'approver', kind: 'user', target: 'khaliq' });
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
