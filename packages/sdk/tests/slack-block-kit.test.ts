import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { slackWriteback, type SlackCall } from '../src/slack-writeback.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Release*' } }];
const attachments = [{ color: '#36a64f', fallback: 'Release', blocks }];

it.each<{ params: Extract<SlackCall, { verb: 'post' }>['params']; body: object }>([
  { params: { channel: 'C1', text: 'hello' }, body: { text: 'hello' } },
  { params: { channel: 'C1', text: { text: 'Release', blocks, attachments }, opts: { replyTo: 'parent' } },
    body: { text: 'Release', blocks, attachments, parentRef: 'parent' } },
  { params: { channel: 'C1', text: { blocks } }, body: { blocks } },
  { params: { channel: 'C1', text: { attachments } }, body: { attachments } },
  { params: { channel: 'C1', text: 'Release', opts: { blocks, attachments } },
    body: { text: 'Release', blocks, attachments } },
])('delivers the structured writeback body: $body', async ({ params, body }) => {
  vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
  const dataDir = mkdtempSync(join(tmpdir(), 'slack-block-kit-'));
  directories.push(dataDir);
  // Model the journal serialization boundary used by first dispatch and resume.
  const call: SlackCall = JSON.parse(JSON.stringify({ type: 'effect', provider: 'slack', verb: 'post', params }));
  const receipt = await slackWriteback(call, dataDir, 'run', 'step', new AbortController().signal);
  expect(receipt).toEqual({ channel: 'C1', ts: 'mock-step', ref: 'mock-ref-step' });
  const written = JSON.parse(readFileSync(join(dataDir, 'mock-writeback/slack/step.json'), 'utf8'));
  expect(written.request).toMatchObject({ provider: 'slack', resource: 'messages', parameters: { channelId: 'C1' } });
  expect(written.request.body).toEqual({ ...body, idempotencyKey: 'run:step' });
});
