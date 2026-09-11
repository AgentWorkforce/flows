import { slackClient } from '@relayfile/relay-helpers';
import type { SlackHelper } from '@relayflows/surface';
import { helperTransport } from './helper-writeback.js';
export { atomicJson, receiptPath, readHelperReceipt as readSlackReceipt } from './helper-storage.js';

export type SlackCall =
  | { type: 'effect'; provider: 'slack'; verb: 'post'; params: { channel: string; text: Parameters<SlackHelper['post']>[1]; opts?: Parameters<SlackHelper['post']>[2] } }
  | { type: 'effect'; provider: 'slack'; verb: 'dm'; params: { user: string; text: string } }
  | { type: 'effect'; provider: 'slack'; verb: 'reply'; params: { channel: string; threadTs: string; text: string } }
  | { type: 'effect'; provider: 'slack'; verb: 'react'; params: { channel: string; messageTs: string; emoji: string } };

export async function slackWriteback(
  call: SlackCall, dataDir: string, runId: string, stepId: string, signal: AbortSignal,
): Promise<unknown> {
  const { transport, deliveredRef } = helperTransport(call, dataDir, runId, stepId, signal);
  const client = slackClient({ transport });
  switch (call.verb) {
    case 'post': return client.post(call.params.channel,
      typeof call.params.text === 'string' ? call.params.text : call.params.text.text ?? '', call.params.opts);
    case 'dm': return client.dm(call.params.user, call.params.text);
    case 'reply': return { ...await client.reply(call.params.channel, call.params.threadTs, call.params.text), ref: deliveredRef() };
    case 'react': await client.react(call.params.channel, call.params.messageTs, call.params.emoji); return null;
  }
}
