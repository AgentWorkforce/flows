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
  it('accepts every generated declaration', () => {
    expect(preflightProviderTriggers([
      github.issues(), github.pull_request('opened'), github.push({ ref: 'refs/heads/main' }),
      slack.mention('C123'), slack.reaction('eyes'), slack.message(),
    ])).toEqual([]);
    expect(providerDeclaration(slack.mention('C123')))
      .toEqual({ provider: 'slack', type: 'app_mention', events: expect.arrayContaining(['app_mention']) });
  });

  it('never reads a generic webhook as a provider subscription', () => {
    // A provider trigger IS a webhook, so the filter alone cannot prove intent.
    // Each of these is a valid generic inbox delivered by `POST /<name>`, and
    // refusing any of them would refuse a working flow.
    const generic = [
      webhook('release'),
      webhook('release', { tag: 'v1' }),
      // A payload field that merely happens to be called `provider`.
      webhook('deploys', { provider: 'aws' }),
      webhook('deploys', { provider: 'aws', type: 'stack.updated' }),
      // Names a provider other than its own inbox: still a generic match.
      webhook('github', { provider: 'slack', type: 'app_mention' }),
      // A real provider inbox, but no pinned type: subscribes to every event.
      webhook('github', { provider: 'github' }),
      // A pinned type that is not a string cannot be compared to one.
      webhook('slack', { provider: 'slack', type: 42 }),
    ];
    for (const source of generic) expect(providerDeclaration(source)).toBeUndefined();
    expect(preflightProviderTriggers(generic)).toEqual([]);
  });

  it('refuses at author time what provider ingress refuses at delivery', () => {
    // The refusal is paired with the `providerInboxEvent` throw it predicts.
    // If these two ever disagree the trapdoor is back: a flow that passes
    // `flows check` and dies on its first real event.
    const undeliverable = webhook('slack', { provider: 'slack', type: 'pull_request', payload: {} });
    const [refusal] = preflightProviderTriggers([undeliverable]);
    expect(refusal).toEqual(expect.objectContaining({
      severity: 'refusal', kind: 'invalid_spec', executor: 'slack',
    }));
    // The message has to name what IS accepted; "invalid" alone sends the
    // author back to the adapter mappings to find out.
    expect(refusal!.message).toContain('pull_request');
    expect(refusal!.message).toContain('app_mention');
    expect(() => providerInboxEvent('slack', { type: 'pull_request', payload: {} }))
      .toThrow(/unknown event type/);
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
    expect(reports.join('\n')).toContain('does not publish');

    reports.length = 0;
    await writeFile(deliverable, "import { flow, slack } from '@relayflows/surface';\n"
      + "export default flow('test').on(slack.mention('C123'), "
      + "async () => { throw new Error('handler ran'); });");
    expect(await runCli(['check', '--json', deliverable], io)).toBe(0);
  });
});
