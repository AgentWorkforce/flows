import type { Ctx } from '../src/index.js';

export function rejectedHelpers(f: Ctx): void {
  // @ts-expect-error channels must be strings.
  f.slack.post(42, 'hi');
  // @ts-expect-error preserve the bespoke option key.
  f.slack.post('#test', 'hi', { replyToo: '123' });
  // @ts-expect-error user IDs must be strings.
  f.slack.dm(42, 'hi');
  // @ts-expect-error replies require a text argument.
  f.slack.reply('#test', '123.456');
  // @ts-expect-error emojis must be strings.
  f.slack.react('#test', '123.456', 42);
  // @ts-expect-error unsupported provider namespaces stay closed.
  f.notarealprovider.anything();
  // @ts-expect-error resource clients do not have runtime dispatch yet.
  f.slack.messages.list();
  // @ts-expect-error f.gitlab carries comments and discussions only.
  f.gitlab.issues.list({ projectPath: 'g/p' });
  // @ts-expect-error merge requests are not in gitlab's writeback catalog.
  f.gitlab.mergeRequests.write({ projectPath: 'g/p' }, { title: 'x' });
}
