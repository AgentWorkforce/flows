import { PreviewTransport, type gitlabClient } from '@relayfile/relay-helpers';
import { helperClients, type HelperCall } from '@relayflows/surface/runtime';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { helperTransport } from '../src/helper-writeback.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const projectPath = 'acme/platform/web';
const prefix = `/gitlab/projects/${projectPath}`;
const issues = Array.from({ length: 8 }, (_, index) => ({ iid: index + 1, title: `issue ${index + 1}`, state: index === 7 ? 'closed' : 'opened' }));
const requests = [{ iid: 9, title: 'merged request', state: 'merged' }];

function collectionFixtures(): Record<string, unknown> {
  return {
    ...Object.fromEntries(issues.map(issue => [`${prefix}/issues/${issue.iid}__issue/meta.json`, issue])),
    [`${prefix}/merge_requests/9__request/meta.json`]: requests[0],
    [`${prefix}/issues/_index.json`]: issues.map(({ iid }) => ({ iid })),
    [`${prefix}/merge_requests/_index.json`]: [{ iid: 9 }],
    [`${prefix}/issues/1__issue/comments/1.json`]: { iid: 'child' },
    [`${prefix}/issues/1__issue/children/meta.json`]: { iid: 'grandchild' },
    [`${prefix}/issues/by-id/1.json`]: { iid: 'alias' },
    [`${prefix}/issues/by-id/1/meta.json`]: { iid: 'directory-alias' },
    '/gitlab/projects/acme/other/issues/1__foreign/meta.json': { iid: 'foreign' },
  };
}

for (const mode of ['filesystem', 'preview'] as const) {
  for (const resource of ['issues', 'merge-requests'] as const) {
    it(`${mode} lists exact ${resource} records through the shipped Surface factory`, async () => {
      const fixtures = collectionFixtures();
      let transport;
      if (mode === 'preview') {
        transport = new PreviewTransport({ fixtures });
      } else {
        const directory = mkdtempSync(join(tmpdir(), 'gitlab-helper-collections-'));
        directories.push(directory);
        for (const [path, value] of Object.entries(fixtures)) {
          const target = join(directory, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, JSON.stringify(value));
        }
        symlinkSync('1__issue', join(directory, prefix, 'issues', 'linked-record'));
        vi.stubEnv('RELAYFILE_MOUNT_PATH', directory);
        vi.stubEnv('RELAYFLOWS_GITLAB_MOCK', '0');
        const call: HelperCall = { type: 'effect', provider: 'gitlab', verb: `${resource}.list`, args: [{ projectPath }] };
        transport = helperTransport(call, directory, 'collection-proof', resource, new AbortController().signal).transport;
      }
      const client = helperClients.gitlab!({ transport }) as ReturnType<typeof gitlabClient>;
      expect(await client[resource].list({ projectPath })).toEqual(resource === 'issues' ? issues : requests);
    });
  }
}

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
