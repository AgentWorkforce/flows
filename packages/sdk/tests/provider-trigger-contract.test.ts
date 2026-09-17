import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { github, slack, webhook } from '@relayflows/surface';
import { preflightProviderTriggers, providerDeclaration } from '../src/provider-trigger-contract.js';
import { providerInboxEvent } from '../src/trigger-executor.js';
import { preflightWebhookTriggers } from '../src/preflight.js';
import { runCli } from '../src/cli.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flows-provider-contract-'));
  dirs.push(dir);
  return dir;
}

describe('provider trigger contract', () => {
  it('accepts every generated declaration and never inspects a plain webhook', () => {
    expect(preflightProviderTriggers([
      github.issues(), github.pull_request('opened'), github.push({ ref: 'refs/heads/main' }),
      slack.mention('C123'), slack.reaction('eyes'), slack.message(),
      webhook('release'), webhook('release', { tag: 'v1' }),
    ])).toEqual([]);
    // A plain webhook carries no `filter.provider`, so it is not a provider
    // subscription and this contract must stay out of its way entirely.
    expect(providerDeclaration(webhook('release'))).toBeUndefined();
    expect(providerDeclaration(webhook('release', { tag: 'v1' }))).toBeUndefined();
    expect(providerDeclaration(slack.mention('C123')))
      .toEqual({ inbox: 'slack', provider: 'slack', type: 'app_mention' });
    // `filter.provider` with no pinned type subscribes to every event on that
    // inbox. That is legal, so it must not refuse.
    expect(preflightProviderTriggers([webhook('github', { provider: 'github' })])).toEqual([]);
  });

  it('refuses at author time exactly what provider ingress refuses at delivery', () => {
    // Each case pairs the check-time refusal with the ingress throw it
    // predicts. If these two ever disagree, the trapdoor is back: a flow that
    // passes `flows check` and dies on its first real event.
    const unknownProvider = webhook('notion', { provider: 'notion', type: 'page', payload: {} });
    expect(preflightProviderTriggers([unknownProvider])).toEqual([expect.objectContaining({
      severity: 'refusal', kind: 'provider_unknown', executor: 'notion',
    })]);
    expect(() => providerInboxEvent('notion', { type: 'page', payload: {} }))
      .toThrow(/unknown provider/);

    const unknownEvent = webhook('slack', { provider: 'slack', type: 'pull_request', payload: {} });
    const [eventRefusal] = preflightProviderTriggers([unknownEvent]);
    expect(eventRefusal).toEqual(expect.objectContaining({
      severity: 'refusal', kind: 'provider_event_unknown', executor: 'slack',
    }));
    // The message has to name what IS accepted; "invalid" alone sends the
    // author back to the adapter mappings to find out.
    expect(eventRefusal!.message).toContain('app_mention');
    expect(eventRefusal!.message).toContain('pull_request');
    expect(() => providerInboxEvent('slack', { type: 'pull_request', payload: {} }))
      .toThrow(/unknown event type/);

    const mismatched = webhook('github', { provider: 'slack', type: 'issues', payload: {} });
    expect(preflightProviderTriggers([mismatched])).toEqual([expect.objectContaining({
      severity: 'refusal', kind: 'provider_mismatch', executor: 'github',
    })]);
    expect(() => providerInboxEvent('github', { provider: 'slack', type: 'issues', payload: {} }))
      .toThrow(/does not match/);
  });

  it('reports one refusal per distinct declaration, not per handler', () => {
    const bad = webhook('slack', { provider: 'slack', type: 'nope', payload: {} });
    expect(preflightProviderTriggers([bad, bad, bad])).toHaveLength(1);
    expect(preflightProviderTriggers([
      bad, webhook('slack', { provider: 'slack', type: 'also-nope', payload: {} }),
    ])).toHaveLength(2);
  });

  it('is orthogonal to executor registration', () => {
    // Registration and deliverability are different questions. A provider
    // trigger can be registered and undeliverable, or unregistered and
    // perfectly well formed; each check reports only its own.
    const bad = webhook('slack', { provider: 'slack', type: 'nope', payload: {} });
    expect(preflightWebhookTriggers([bad], ['slack'])).toEqual([]);
    expect(preflightProviderTriggers([bad])).toHaveLength(1);
    expect(preflightWebhookTriggers([slack.mention('C123')], [])).toHaveLength(1);
    expect(preflightProviderTriggers([slack.mention('C123')])).toEqual([]);
  });

  it('fails `flows check` before deployment and passes once the event is real', async () => {
    const dir = await temporary();
    await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'flows.json'), '{"executors":["slack"]}');
    // Two files, not one rewritten twice: `loadAuthoredFlow` imports the flow
    // and Node's ESM cache keys on the URL, so overwriting a path re-imports
    // the first module and the second check would grade stale source.
    const undeliverable = join(dir, 'undeliverable.flow.ts');
    const deliverable = join(dir, 'deliverable.flow.ts');
    const reports: string[] = [];
    const io = {
      stdout: (line: string) => reports.push(line),
      stderr: (line: string) => reports.push(line),
    };

    await writeFile(undeliverable, "import { flow, webhook } from '@relayflows/surface';\n"
      + "export default flow('test').on(webhook('slack', { provider: 'slack', type: 'nope', payload: {} }), "
      + "async () => { throw new Error('handler ran'); });");
    expect(await runCli(['check', '--json', undeliverable], io)).toBe(2);
    expect(reports.join('\n')).toContain('provider_event_unknown');

    reports.length = 0;
    await writeFile(deliverable, "import { flow, slack } from '@relayflows/surface';\n"
      + "export default flow('test').on(slack.mention('C123'), "
      + "async () => { throw new Error('handler ran'); });");
    expect(await runCli(['check', '--json', deliverable], io)).toBe(0);
  });
});
