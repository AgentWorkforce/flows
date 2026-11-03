import { PreviewTransport, type gitlabClient } from '@relayfile/relay-helpers';
import { helperClients } from '@relayflows/surface/runtime';
import { expect, it } from 'vitest';

it('reads and writes the mounted GitLab project through the shipped helper factory', async () => {
  const projectPath = 'acme/platform/web';
  const path = '/gitlab/projects/acme/platform/web/issues/5__existing/meta.json';
  const issue = { iid: 5, title: 'existing' };
  const transport = new PreviewTransport({ fixtures: { [path]: issue } });
  const client = helperClients.gitlab!({ transport }) as ReturnType<typeof gitlabClient>;

  expect(await client.issues.read({ projectPath, issueIid: 5, slug: 'existing' })).toEqual(issue);
  await client.issues.write({ projectPath }, { title: 'new issue' });
  expect(transport.actions).toMatchObject([
    { kind: 'provider.read', path },
    { kind: 'provider.write', path: expect.stringMatching(/^\/gitlab\/projects\/acme\/platform\/web\/issues\/[^/]+\.json$/u), body: { title: 'new issue' } },
  ]);
});
