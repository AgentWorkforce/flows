import { flow, type Step } from '../../src/index.js';

/** Smoke fixture: these four operations must compile to journal-backed steps. */
export default flow('helpers-smoke', async f => {
  const issue = f.github.createIssue({ repo: 'owner/repo', title: 'Smoke', body: 'hello' });
  const check: Step<{ status: string }> = issue;
  await check;
  await f.linear.createIssue({ teamId: 'team', title: 'Smoke' });
  await f.notion.appendBlock({ pageId: 'page', block: { type: 'paragraph', paragraph: { rich_text: [] } } });
  await f.stripe.createInvoice({ customer: 'cus_123' });
  await f.slack.post('#test', 'hello');
  await f.googleDrive.files.write({}, { name: 'Smoke' });
  f.done('success');
});

export const invalid = flow('invalid-helper-args', async f => {
  // @ts-expect-error upstream requires teamId
  await f.linear.createIssue({ title: 'Missing team' });
  // @ts-expect-error repo must be a string
  await f.github.createIssue({ repo: 42, title: 'Bad repo', body: '' });
  // @ts-expect-error invoice requires a customer
  await f.stripe.createInvoice({});
  // @ts-expect-error nonexistent provider verb
  await f.asana.noSuchVerb({});
  f.done('success');
});
