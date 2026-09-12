import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { startWebhookServer, parseWebhookArgs } from '../src/cli/serve-webhook.js';
import { preflightWebhookTriggers } from '../src/preflight.js';
import { webhook, slack, github } from '@relayflows/surface';
import { webhookTriggerSpec } from '../src/trigger-executor.js';
import { runCli } from '../src/cli.js';
import { runDirectFlow } from '../src/cli/direct-run.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => {
    server.close(() => done()); server.closeAllConnections();
  });
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flows-webhook-'));
  dirs.push(dir); return dir;
}
async function receiver(dir: string): Promise<string> {
  const server = await startWebhookServer(dir, 0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP address');
  return `http://127.0.0.1:${address.port}`;
}

describe('webhook ingress', () => {
  it('lowers provider subscriptions to provider inbox executors with payload filters', () => {
    expect(webhookTriggerSpec('mention', slack.mention('C123'))).toEqual({
      id: 'mention', executor: 'slack', eventType: 'slack', dedupeKeyTemplate: '{{event.type}}',
      pattern: { provider: 'slack', type: 'app_mention', payload: { channel: 'C123' } },
    });
    expect(preflightWebhookTriggers([slack.mention('C123'), slack.reaction('eyes'), github.pull_request()], ['slack']))
      .toEqual([expect.objectContaining({ kind: 'no_executor', executor: 'github' })]);
    expect(webhookTriggerSpec('plain', webhook('release')).pattern).toBeUndefined();
  });
  it('routes provider envelopes to isolated inboxes and rejects spoofed or unsupported events', async () => {
    const dir = await temporary();
    const base = await receiver(dir);
    const post = (provider: string, body: unknown) => fetch(`${base}/providers/${provider}`, {
      method: 'POST', body: JSON.stringify(body),
    });
    for (const [provider, type, payload] of [
      ['slack', 'app_mention', { channel: 'C123', text: 'hello' }],
      ['github', 'pull_request', { action: 'opened', number: 42 }],
    ] as const) {
      const response = await post(provider, { type, payload });
      expect(response.status).toBe(202);
      const { id } = await response.json() as { id: string };
      expect(JSON.parse(await readFile(join(dir, 'inbox', provider, `${id}.json`), 'utf8')))
        .toEqual({ provider, type, payload });
    }
    for (const body of [null, {}, { type: 'pull_request', payload: {} },
      { provider: 'github', type: 'app_mention', payload: {} },
      { type: 'app_mention', payload: [] }, { type: 'app_mention', payload: null }]) {
      expect((await post('slack', body)).status).toBe(400);
    }
    expect((await post('unknown', { type: 'push', payload: {} })).status).toBe(400);
    expect((await post('slack%2Fgithub', { type: 'push', payload: {} })).status).toBe(404);
    expect(await readdir(join(dir, 'inbox', 'slack'))).toHaveLength(1);
    expect(await readdir(join(dir, 'inbox'))).toEqual(['github', 'slack']);
  });
  it('requires registered executor names with the exact refusal', () => {
    expect(preflightWebhookTriggers([webhook('unregistered')], [])).toEqual([{
      severity: 'refusal', kind: 'no_executor', executor: 'unregistered',
      message: 'webhook trigger "unregistered" is not registered in flows.json',
    }]);
    expect(preflightWebhookTriggers([webhook('registered')], ['registered'])).toEqual([]);
  });
  it('checks TS declarations against flows.json without invoking handlers', async () => {
    const dir = await temporary();
    await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const path = join(dir, 'test.flow.ts');
    await writeFile(path, `import { flow, webhook } from '@relayflows/surface';\nexport default flow('test').on(webhook('unregistered'), async () => { throw new Error('handler ran'); });`);
    const reports: string[] = [];
    const io = { stdout: (line: string) => reports.push(line), stderr: (line: string) => reports.push(line) };
    await writeFile(join(dir, 'flows.json'), '{"executors":[]}');
    expect(await runCli(['check', '--json', path], io)).toBe(2);
    expect(reports.join('\n')).toContain('no_executor');
    const refusedRun = await runDirectFlow(path, '{}', join(dir, 'daemon'), { daemon: { spawn: false } });
    expect(refusedRun.exitCode).toBe(2);
    expect(refusedRun.report.diagnostics[0]?.kind).toBe('no_executor');
    expect(await readdir(dir)).not.toContain('daemon');
    reports.length = 0;
    await writeFile(join(dir, 'flows.json'), '{"executors":["unregistered"]}');
    expect(await runCli(['check', '--json', path], io)).toBe(0);
  });
  it('accepts JSON through atomic files without creating a daemon', async () => {
    const dir = await temporary();
    const base = await receiver(dir);
    const payload = { nested: [1, null, 'é'], action: 'release' };
    const response = await fetch(`${base}/release`, { method: 'POST', body: JSON.stringify(payload) });
    expect(response.status).toBe(202);
    const receipt = await response.json() as { id: string };
    expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readdir(join(dir, 'inbox', 'release'))).toEqual([`${receipt.id}.json`]);
    expect(JSON.parse(await readFile(join(dir, 'inbox', 'release', `${receipt.id}.json`), 'utf8'))).toEqual(payload);
    expect(await readdir(dir)).toEqual(['inbox']);
  });
  it('rejects malformed, oversized, traversal, and non-POST requests', async () => {
    const dir = await temporary();
    const base = await receiver(dir);
    expect((await fetch(`${base}/release`)).status).toBe(405);
    expect((await fetch(`${base}/bad%2Fpath`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/release`, { method: 'POST', body: '{' })).status).toBe(400);
    expect((await fetch(`${base}/release`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await fetch(`${base}/release`, { method: 'POST', body: '{"value":1e400}' })).status).toBe(400);
    expect(await readdir(join(dir, 'inbox'))).toEqual([]);
  });
  it('fails closed on a symlink inbox target', async () => {
    const dir = await temporary();
    const outside = await temporary();
    const base = await receiver(dir);
    await symlink(outside, join(dir, 'inbox', 'release'), 'dir');
    expect((await fetch(`${base}/release`, { method: 'POST', body: '{}' })).status).toBe(500);
    expect(await readdir(outside)).toEqual([]);
  });
  it('parses CLI options strictly', () => {
    expect(parseWebhookArgs(['--data-dir', 'data', '--port', '0'])).toEqual({ command: 'serve-webhook', dataDir: 'data', port: 0 });
    expect(parseWebhookArgs(['--data-dir', 'data', '--port', '0', '--allow', 'release,push']))
      .toEqual({ command: 'serve-webhook', dataDir: 'data', port: 0, admitted: ['release', 'push'] });
    for (const args of [[], ['--port', '80'], ['--data-dir', 'x', '--port', '65536'],
      ['--data-dir', 'x', '--port', '1', '--port', '2'], ['--data-dir', 'x', '--port', '3.1'],
      // #303 admission: empty --allow list and invalid names refuse at parse time
      ['--data-dir', 'x', '--port', '0', '--allow', ''],
      ['--data-dir', 'x', '--port', '0', '--allow', '../oops'],
      ['--data-dir', 'x', '--port', '0', '--allow', 'ok,../oops']]) {
      expect(parseWebhookArgs(args)).toBeUndefined();
    }
  });
  it('admits only loaded flow trigger names when the allowlist is set (#303)', async () => {
    const dir = await temporary();
    const server = await startWebhookServer(dir, 0, { admittedNames: new Set(['release', 'push']) });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP address');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/release`, { method: 'POST', body: '{"ok":true}' })).status).toBe(202);
    expect((await fetch(`${base}/push`, { method: 'POST', body: '{"ok":true}' })).status).toBe(202);
    const unknown = await fetch(`${base}/rogue`, { method: 'POST', body: '{"ok":true}' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'webhook_flow_unknown', name: 'rogue' });
    // Unadmitted names never write to disk — the daemon can't drain what wasn't accumulated.
    expect(await readdir(join(dir, 'inbox'))).toEqual(['push', 'release']);
  });
});
