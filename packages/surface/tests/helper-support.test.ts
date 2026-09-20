import { expect, it } from 'vitest';
import {
  createHelpers, helperClients, helperProviders, helperProviderEntry, invokeHelper,
  unsupportedHelperMemberMessage, UnsupportedHelperMemberError, type HelperCall,
} from '../src/runtime.js';

const calls: HelperCall[] = [];
const helpers = () => createHelpers(call => { calls.push(call); return {} as never; });
/** Reaching for an absent resource must refuse without any provider I/O. */
const refusingTransport = {
  async read() { throw new Error('provider I/O'); },
  async list() { throw new Error('provider I/O'); },
  async write() { throw new Error('provider I/O'); },
};
const gitlab = () => helpers().gitlab as unknown as Record<string, any>;

it('records gitlab as partial with its resources and note, and github as fully dispatching', () => {
  const entry = helperProviderEntry('gitlab')!;
  expect(entry.supported).toBe('partial');
  expect(entry.resources).toEqual(['comments', 'discussions']);
  expect(entry.note).toBe('Comments and discussions only. Issue list/read/create and '
    + 'merge-request list/read/create are unavailable through f.gitlab.');
  const github = helperProviderEntry('github')!;
  expect(github.supported).toBe(true);
  expect(github.resources).toContain('issues');
  expect(github.resources).toContain('pull-requests');
  expect(github.note).toBeUndefined();
});

it('keeps every catalog entry to the three support designations, with resources and notes to match', () => {
  for (const provider of helperProviders) {
    expect([true, 'partial', false], provider.provider).toContain(provider.supported);
    // `note` explains a partial's limit; nothing else has a limit to explain.
    expect('note' in provider, provider.provider).toBe(provider.supported === 'partial');
    expect([...provider.resources], provider.provider).toEqual([...provider.resources].sort());
    if (provider.supported === false) expect(provider.resources, provider.provider).toEqual([]);
    if (provider.supported === 'partial') expect(provider.resources.length, provider.provider).toBeGreaterThan(0);
  }
});

it('refuses an absent gitlab resource by dot, bracket and aliased access, naming what is available', () => {
  const f = gitlab();
  const expected = 'f.gitlab.issues is unavailable; available resources: comments, discussions.'
    + ' Comments and discussions only. Issue list/read/create and merge-request'
    + ' list/read/create are unavailable through f.gitlab.';
  expect(() => f.issues).toThrow(UnsupportedHelperMemberError);
  expect(() => f.issues).toThrow(expected);
  expect(() => f['merge_requests']).toThrow('f.gitlab.merge_requests is unavailable; available resources: comments, discussions.');
  const member = ['merge', 'Requests'].join('');
  expect(() => f[member]).toThrow('f.gitlab.mergeRequests is unavailable');
  expect(() => f.comments.merge).toThrow('f.gitlab.comments.merge is unavailable; available verbs on comments: list, path, read, write.');
  expect(calls).toEqual([]);
});

it('carries the refused member, its resource and the available names structurally', () => {
  try { gitlab().issues; expect.unreachable('f.gitlab.issues resolved'); } catch (error) {
    const refusal = error as UnsupportedHelperMemberError;
    expect(refusal.name).toBe('UnsupportedHelperMemberError');
    expect(refusal.provider).toBe('gitlab');
    expect(refusal.member).toBe('issues');
    expect(refusal.resource).toBeUndefined();
    expect(refusal.available).toEqual(['comments', 'discussions']);
  }
});

it('words the refusal once, for the property guard and the authored envelope alike', async () => {
  const expected = unsupportedHelperMemberMessage('gitlab', 'issues', ['comments', 'discussions']);
  const guarded = (() => { try { gitlab().issues; return ''; } catch (error) { return (error as Error).message; } })();
  expect(guarded).toBe(expected);
  // The SDK's `flows check` restates this wording rather than importing it —
  // it is installed against a published surface, which need not export the
  // function yet — and pins the two equal in its own helper-partial-support test.
  await expect(invokeHelper(helperClients['gitlab']!,
    { type: 'effect', provider: 'gitlab', verb: 'issues.list', args: [] }, refusingTransport))
    .rejects.toThrow(expected);
});

it('leaves ordinary object behavior on the guarded helper intact', async () => {
  const f = gitlab();
  expect(Object.keys(f)).toEqual(['comments', 'discussions']);
  expect([...Object.keys({ ...f })]).toEqual(['comments', 'discussions']);
  expect(await f).toBe(f);
  expect((f as any).then).toBeUndefined();
  expect((f as any).toJSON).toBeUndefined();
  expect((f as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined();
  expect(f.hasOwnProperty('comments')).toBe(true);
  expect(typeof f.comments.write).toBe('function');
});

it('keeps path a synchronous builder and dispatch unchanged on the resources gitlab does carry', () => {
  calls.length = 0;
  const f = gitlab();
  const params = { projectPath: 'g/p', issueIid: '1', slug: 's' };
  expect(f.comments.path(params)).toBe('/gitlab/projects/g%2Fp/issues/1__s/comments');
  expect(calls).toEqual([]);
  f.comments.write(params, { text: 'hi' });
  expect(calls).toEqual([{ type: 'effect', provider: 'gitlab', verb: 'comments.write',
    args: [params, { text: 'hi' }] }]);
});

it('does not guard a fully supported provider', () => {
  const f = helpers().github as unknown as Record<string, unknown>;
  expect(f.nonexistent).toBeUndefined();
  expect(typeof (f.issues as Record<string, unknown>).write).toBe('function');
});

it('repeats the refusal for an authored envelope that never touched the helper, without provider I/O', async () => {
  const gitlabFactory = helperClients['gitlab']!;
  await expect(invokeHelper(gitlabFactory,
    { type: 'effect', provider: 'gitlab', verb: 'issues.write', args: [] }, refusingTransport))
    .rejects.toThrow('f.gitlab.issues is unavailable; available resources: comments, discussions.');
  await expect(invokeHelper(gitlabFactory,
    { type: 'effect', provider: 'gitlab', verb: 'comments.merge', args: [] }, refusingTransport))
    .rejects.toThrow('f.gitlab.comments.merge is unavailable; available verbs on comments: list, read, write.');
  // `path` is a synchronous builder; dispatching it stays banned and is not
  // advertised as a verb an author could call instead.
  await expect(invokeHelper(gitlabFactory,
    { type: 'effect', provider: 'gitlab', verb: 'comments.path', args: [] }, refusingTransport))
    .rejects.toThrow(UnsupportedHelperMemberError);
  await expect(invokeHelper(helperClients['github']!,
    { type: 'effect', provider: 'github', verb: 'issues.nope', args: [] }, refusingTransport))
    .rejects.toThrow('Unknown helper verb');
});
