import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { slackClient } from '@relayfile/relay-helpers';
import { flowRunWritebackIdempotency, type SlackHelper } from '@relayflows/surface';
import { slackPostBody } from '@relayflows/surface/runtime';
import type { RelayTransport } from '@relayfile/relay-helpers/transport';
import { writeJsonFile, type WritebackResult } from '@relayfile/adapter-core/vfs-client';
import { slackMount } from './slack-preflight.js';

export type SlackCall =
  | { type: 'effect'; provider: 'slack'; verb: 'post'; params: { channel: string; text: Parameters<SlackHelper['post']>[1]; opts?: Parameters<SlackHelper['post']>[2] } }
  | { type: 'effect'; provider: 'slack'; verb: 'dm'; params: { user: string; text: string } }
  | { type: 'effect'; provider: 'slack'; verb: 'reply'; params: { channel: string; threadTs: string; text: string } }
  | { type: 'effect'; provider: 'slack'; verb: 'react'; params: { channel: string; messageTs: string; emoji: string } };

/** Durable receipt precedes effect.confirm, so a confirmed replay can recover it. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function receiptPath(dataDir: string, runId: string, stepId: string): string {
  return join(dataDir, 'helper-receipts', createHash('sha256').update(`${runId}:${stepId}`).digest('hex') + '.json');
}

export async function slackWriteback(
  call: SlackCall, dataDir: string, runId: string, stepId: string, signal: AbortSignal,
): Promise<unknown> {
  const idempotencyKey = flowRunWritebackIdempotency(runId, stepId);
  let deliveredRef = '';
  const transport: RelayTransport = {
    async read() { throw new Error('Slack effect transport is write-only'); },
    async list() { throw new Error('Slack effect transport is write-only'); },
    async write(request) {
      signal.throwIfAborted();
      // The pinned adapter's ergonomic post accepts text only. Preserve structured
      // content at its transport boundary, retaining its paths and receipt handling.
      const content = call.verb === 'post'
        ? slackPostBody(call.params.text, call.params.opts)
        : request.body as Record<string, unknown>;
      const body: Record<string, unknown> = { ...content, idempotencyKey };
      const stamped = { ...request, body };
      const draft = `${request.path}/draft-${createHash('sha256').update(idempotencyKey).digest('hex')}.json`;
      if (process.env.RELAYFLOWS_SLACK_MOCK === '1') {
        const ts = `mock-${stepId}`;
        deliveredRef = `mock-ref-${stepId}`;
        const result: WritebackResult = { path: deliveredRef, absolutePath: draft, deliveryStatus: 'confirmed', receipt: { externalId: ts } };
        await atomicJson(join(dataDir, 'mock-writeback', 'slack', `${stepId}.json`), {
          ...call, ...body, channel: request.parameters.channelId,
          ...(body.parentRef === undefined ? {} : { replyTo: body.parentRef }),
          runId, stepId, request: stamped, receipt: result.receipt,
        });
        return result;
      }
      const mount = slackMount();
      if (mount !== undefined) {
        const result = await writeJsonFile({ relayfileMountRoot: mount }, 'slack', `write.${request.resource}`, draft, body);
        if (result.deliveryStatus !== 'confirmed' || !result.receipt) throw new Error('Slack writeback is pending; no delivery receipt');
        if (call.verb !== 'react' && !result.receipt.externalId && !result.receipt.ts) throw new Error('Slack writeback has no delivered timestamp');
        deliveredRef = result.path;
        return result;
      }
      throw new Error('Slack effect requires a relayfile mount; direct bot-token transport is not implemented');
    },
  };
  const client = slackClient({ transport });
  switch (call.verb) {
    case 'post': return client.post(call.params.channel,
      typeof call.params.text === 'string' ? call.params.text : call.params.text.text ?? '', call.params.opts);
    case 'dm': return client.dm(call.params.user, call.params.text);
    case 'reply': return { ...await client.reply(call.params.channel, call.params.threadTs, call.params.text), ref: deliveredRef };
    case 'react': await client.react(call.params.channel, call.params.messageTs, call.params.emoji); return null;
  }
}

export async function readSlackReceipt(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
