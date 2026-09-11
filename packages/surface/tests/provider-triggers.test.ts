import { describe, expect, it } from 'vitest';
import { flow, github, slack, type ProviderTriggerSource } from '@relayflows/surface';
import { slack as slackSubpath } from '@relayflows/surface/triggers/slack';
import { github as githubSubpath } from '@relayflows/surface/triggers';
import { getFlowDefinition } from '@relayflows/surface/runtime';

describe('generated provider declarations', () => {
  it('exposes typed, immutable provider subscriptions through the package exports', () => {
    const mention: ProviderTriggerSource<'slack', 'app_mention'> = slack.mention('C123');
    expect(mention).toEqual({ kind: 'webhook', name: 'slack', filter: {
      provider: 'slack', type: 'app_mention', payload: { channel: 'C123' },
    } });
    expect(slack.reaction('eyes').filter).toEqual({
      provider: 'slack', type: 'reaction_added', payload: { reaction: 'eyes' },
    });
    expect(github.pull_request('opened').filter).toEqual({
      provider: 'github', type: 'pull_request', payload: { action: 'opened' },
    });
    expect(github.pull_request().filter).toEqual({ provider: 'github', type: 'pull_request' });
    expect(slackSubpath).toBe(slack);
    expect(githubSubpath).toBe(github);
    expect(Object.isFrozen(slack)).toBe(true);
    expect(Object.isFrozen(mention.filter.payload)).toBe(true);
  });

  it('snapshots filters and preserves routing through flow.on without running handlers', () => {
    const filter = { repository: { name: 'flows' } };
    const source = github.push(filter);
    const declared = flow('providers').on(source, async () => { throw new Error('handler ran'); });
    filter.repository.name = 'changed';
    expect(getFlowDefinition(declared).handlers[0]!.trigger).toEqual(source);
    expect(source.filter.payload).toEqual({ repository: { name: 'flows' } });
    expect(Object.isFrozen(source.filter.payload)).toBe(true);
  });

  it('refuses invalid typed arguments and non-object filters at runtime', () => {
    for (const argument of ['', ' ', null, 1, {}]) {
      expect(() => slack.mention(argument as string)).toThrow(/channel/);
      expect(() => slack.reaction(argument as string)).toThrow(/emoji/);
      expect(() => github.pull_request(argument as string)).toThrow(/action/);
    }
    expect(() => github.push([] as never)).toThrow(/filter/);
    expect(() => github.push({ value: NaN })).toThrow(/filter/);
  });
});

// Compile-time contracts are checked by the surface test tsconfig.
function invalidDeclarations(): void {
  // @ts-expect-error channel is a string
  slack.mention(123);
  // @ts-expect-error emoji is required
  slack.reaction();
  // @ts-expect-error action is a string, not an arbitrary object
  github.pull_request({ action: 'opened' });
  // @ts-expect-error provider and event literals cannot be interchanged
  const source: ProviderTriggerSource<'github', 'push'> = slack.mention('C123');
  void source;
}
void invalidDeclarations;
