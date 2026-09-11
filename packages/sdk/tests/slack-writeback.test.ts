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

it('stamps a real mount draft and waits for its delivered receipt', async () => {
  const dir = setup();
  mkdirSync(join(dir, 'slack'));
  vi.stubEnv('WORKSPACE_ROOT', dir);
  vi.stubEnv('WORKFORCE_TICK_DELIVERY_ID', 'ambient-tick');
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
