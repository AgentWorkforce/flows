import { slackClient } from '@relayfile/relay-helpers';
import type { RelayTransport } from '@relayfile/relay-helpers/transport';
import type { SlackHelper } from '@relayflows/surface';
import { helperTransport } from './helper-writeback.js';
export { atomicJson, receiptPath, readHelperReceipt as readSlackReceipt } from './helper-storage.js';

export type SlackCall =
  | { type: 'effect'; provider: 'slack'; verb: 'post'; params: { channel: string; text: Parameters<SlackHelper['post']>[1]; opts?: Parameters<SlackHelper['post']>[2] } }
  | { type: 'effect'; provider: 'slack'; verb: 'dm'; params: { user: string; text: string } }
  | { type: 'effect'; provider: 'slack'; verb: 'reply'; params: { channel: string; threadTs: string; text: string } }
  | { type: 'effect'; provider: 'slack'; verb: 'react'; params: { channel: string; messageTs: string; emoji: string } };

interface SlackPostBodyExtras { text?: string; dropText: boolean; blocks?: unknown; attachments?: unknown }

// Slice Y widened SlackPostMessage to carry blocks/attachments; the transport
// body is otherwise built by slackClient, which only sees the flattened text.
// Reconstruct the intended body by projecting from the original call.params.
function slackPostBodyExtras(params: Extract<SlackCall, { verb: 'post' }>['params']): SlackPostBodyExtras {
  const extras: SlackPostBodyExtras = { dropText: false };
  const t = params.text;
  const opts = params.opts as { blocks?: unknown; attachments?: unknown } | undefined;
  if (typeof t === 'object' && t !== null) {
    if ('text' in t && typeof t.text === 'string') extras.text = t.text;
    else extras.dropText = true;
    if ('blocks' in t && t.blocks !== undefined) extras.blocks = t.blocks;
    if ('attachments' in t && t.attachments !== undefined) extras.attachments = t.attachments;
  }
  if (opts?.blocks !== undefined) extras.blocks = opts.blocks;
  if (opts?.attachments !== undefined) extras.attachments = opts.attachments;
  return extras;
}

function wrapSlackPostTransport(transport: RelayTransport, extras: SlackPostBodyExtras): RelayTransport {
  return {
    read: transport.read.bind(transport),
    list: transport.list.bind(transport),
    async write(request) {
      const body = { ...request.body as Record<string, unknown> };
      if (extras.dropText) delete body.text;
      else if (extras.text !== undefined) body.text = extras.text;
      if (extras.blocks !== undefined) body.blocks = extras.blocks;
      if (extras.attachments !== undefined) body.attachments = extras.attachments;
      return transport.write({ ...request, body });
    },
  };
}

export async function slackWriteback(
  call: SlackCall, dataDir: string, runId: string, stepId: string, signal: AbortSignal,
): Promise<unknown> {
  const { transport, deliveredRef } = helperTransport(call, dataDir, runId, stepId, signal);
  const effectiveTransport = call.verb === 'post'
    ? wrapSlackPostTransport(transport, slackPostBodyExtras(call.params))
    : transport;
  const client = slackClient({ transport: effectiveTransport });
  switch (call.verb) {
    case 'post': return client.post(call.params.channel,
      typeof call.params.text === 'string' ? call.params.text : call.params.text.text ?? '', call.params.opts);
    case 'dm': return client.dm(call.params.user, call.params.text);
    case 'reply': return { ...await client.reply(call.params.channel, call.params.threadTs, call.params.text), ref: deliveredRef() };
    case 'react': await client.react(call.params.channel, call.params.messageTs, call.params.emoji); return null;
  }
}
