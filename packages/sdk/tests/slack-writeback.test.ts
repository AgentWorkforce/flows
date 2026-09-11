import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { slackWriteback, type SlackCall } from '../src/slack-writeback.js';
import { slackMount } from '../src/slack-preflight.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function setup(): string {
  for (const key of ['RELAYFLOWS_SLACK_MOCK', 'RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
  vi.stubEnv('SLACK_BOT_TOKEN', 'test-token');
  const dir = mkdtempSync(join(tmpdir(), 'slack-write-')); dirs.push(dir); return dir;
}
const post: SlackCall = { type: 'effect', provider: 'slack', verb: 'post', params: { channel: 'C1', text: 'hi' } };
const signal = () => new AbortController().signal;

it('direct-token writes preserve idempotency and thread through the delivered receipt', async () => {
  const dir = setup();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '123.456' })));
  const first = await slackWriteback(post, dir, 'run', 'step1', signal()) as { ref: string };
  fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '123.457' })));
  await slackWriteback({ ...post, params: { ...post.params, opts: { replyTo: first.ref } } }, dir, 'run', 'step2', signal());
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ channel: 'C1', text: 'hi', client_msg_id: 'run:step1' });
  expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toMatchObject({ thread_ts: '123.456', client_msg_id: 'run:step2' });
  expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: 'Bearer test-token' });
});

it('opens DMs and treats an already-present reaction as the same effect', async () => {
  const dir = setup();
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: { id: 'D1' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: '123.456' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'already_reacted' })));
  expect(await slackWriteback({ type: 'effect', provider: 'slack', verb: 'dm', params: { user: 'U1', text: 'hi' } }, dir, 'run', 'dm', signal())).toEqual({ user: 'U1', ts: '123.456' });
  await slackWriteback({ type: 'effect', provider: 'slack', verb: 'react', params: { channel: 'C1', messageTs: '123.456', emoji: 'wave' } }, dir, 'run', 'react', signal());
  expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toMatchObject({ channel: 'D1', client_msg_id: 'run:dm' });
  expect(JSON.parse(String(fetch.mock.calls[2]![1]!.body))).toEqual({ channel: 'C1', timestamp: '123.456', name: 'wave' });
});

it('refuses unsuccessful Slack responses instead of inventing a receipt', async () => {
  const dir = setup();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'missing_scope' })));
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toThrow('missing_scope');
  fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toThrow('no timestamp');
});

it('stamps a real mount draft and waits for its delivered receipt', async () => {
  const dir = setup();
  mkdirSync(join(dir, 'slack'));
  vi.stubEnv('WORKSPACE_ROOT', dir);
  expect(slackMount()).toBe(dir); // Empty higher-precedence env must not mask a mount.
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
  const request = slackWriteback(post, dir, 'run', 'step', signal());
  const messages = join(dir, 'slack/channels/C1/messages');
  let draft: string | undefined;
  for (let i = 0; i < 100 && !draft; i++) {
    try { draft = readdirSync(messages).find(file => file.endsWith('.json')); } catch {}
    if (!draft) await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(draft).toBeDefined();
  const path = join(messages, draft!);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ text: 'hi', idempotencyKey: 'run:step' });
  writeFileSync(path, JSON.stringify({ externalId: '123.456' }));
  expect(await request).toMatchObject({ channel: 'C1', ts: '123.456', ref: expect.any(String) });
  expect(network).not.toHaveBeenCalled();
});
