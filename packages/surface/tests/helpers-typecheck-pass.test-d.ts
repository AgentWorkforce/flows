import type { Ctx, Helpers, SlackHelper, SlackReceipt, Step } from '../src/index.js';

export function supportedHelpers(f: Ctx): void {
  const helpers: Helpers = f;
  const compatible: SlackHelper = helpers.slack;
  const post: Step<SlackReceipt> = f.slack.post('#test', 'hi');
  const reply: Step<SlackReceipt> = f.slack.reply('#test', '123.456', 'hi');
  const dm: Step<{ user: string; ts: string }> = f.slack.dm('U123', 'hi');
  const react: Step<void> = f.slack.react('#test', '123.456', 'eyes');
  f.slack.post('#test', 'hi', { replyTo: '/slack/draft' }).gate(receipt => Boolean(receipt.ts));
  void [compatible, post, reply, dm, react];
}
