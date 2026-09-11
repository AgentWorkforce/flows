import { describe, expect, expectTypeOf, it } from 'vitest';
import { flow, type SlackBlock, type SlackPostMessage, type SlackReceipt, type Step } from '@relayflows/surface';
import { slackPostBody } from '@relayflows/surface/runtime';

const blocks: SlackBlock[] = [
  { type: 'header', text: { type: 'plain_text', text: 'Release shipped' } },
  { type: 'section', text: { type: 'mrkdwn', text: '*All checks passed*' } },
  { type: 'divider' },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Build 42' }] },
  { type: 'image', image_url: 'https://example.com/release.png', alt_text: 'Release' },
];
const attachments = [{ color: '#36a64f', fallback: 'Release shipped', blocks }];

describe('Slack Block Kit posts', () => {
  it('accepts structured messages and options while preserving Step receipts', () => {
    flow('typed-slack', async f => {
      expectTypeOf(f.slack.post('C1', 'hello')).toEqualTypeOf<Step<SlackReceipt>>();
      expectTypeOf(f.slack.post('C1', { text: 'Release', blocks, attachments }))
        .toEqualTypeOf<Step<SlackReceipt>>();
      f.slack.post('C1', { blocks }).gate(receipt => receipt.ts.length > 0);
      f.slack.post('C1', { attachments }, { replyTo: 'draft-parent' });
      f.slack.post('C1', 'Release', { blocks, attachments, replyTo: 'draft-parent' });
      // @ts-expect-error Channel must be a string.
      f.slack.post(42, { blocks });
      // @ts-expect-error Fallback text must be a string.
      f.slack.post('C1', { text: 42 });
      // @ts-expect-error Blocks are structured arrays, not JSON strings.
      f.slack.post('C1', { blocks: '[]' });
      // @ts-expect-error The OpenAPI schema requires each block's type.
      f.slack.post('C1', { blocks: [{ text: 'missing type' }] });
      // @ts-expect-error Block type must be a string.
      f.slack.post('C1', 'Release', { blocks: [{ type: 42 }] });
      // @ts-expect-error Attachments must be objects.
      f.slack.post('C1', { attachments: ['invalid'] });
      // @ts-expect-error No callback registration in the posting API.
      f.slack.post('C1', { blocks }, { callbackUrl: 'https://example.com' });
    });
  });

  it('preserves the plain-text body and replyTo mapping', () => {
    expect(slackPostBody('hello')).toEqual({ text: 'hello' });
    expect(slackPostBody('hello', { replyTo: 'draft-parent' }))
      .toEqual({ text: 'hello', parentRef: 'draft-parent' });
  });

  it('preserves all structured content without mutating the authored message', () => {
    const message: SlackPostMessage = { text: 'Release', blocks, attachments };
    const before = structuredClone(message);
    expect(slackPostBody(message, { replyTo: 'draft-parent' }))
      .toEqual({ ...before, parentRef: 'draft-parent' });
    expect(message).toEqual(before);
  });

  it('supports blocks or attachments without fallback text', () => {
    expect(slackPostBody({ blocks })).toEqual({ blocks });
    expect(slackPostBody({ attachments })).toEqual({ attachments });
  });

  it('supports structured options and explicit empty arrays', () => {
    expect(slackPostBody('Release', { blocks, attachments }))
      .toEqual({ text: 'Release', blocks, attachments });
    expect(slackPostBody({ blocks, attachments }, { blocks: [], attachments: [] }))
      .toEqual({ blocks: [], attachments: [] });
  });
});
