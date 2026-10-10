import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { helperReceiptTimeoutMs, HelperWritebackPending } from '../src/helper-receipt.js';
import { slackWriteback, type SlackCall } from '../src/slack-writeback.js';
import { helperWriteback } from '../src/helper-writeback.js';
import { receiptPath } from '../src/helper-storage.js';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function setup(timeout: string) {
  const dir = mkdtempSync(join(tmpdir(), 'helper-receipt-')); dirs.push(dir);
  mkdirSync(join(dir, 'slack')); mkdirSync(join(dir, 'github'));
  vi.stubEnv('RELAYFILE_MOUNT_PATH', dir);
  vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '0'); vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '0');
  vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', timeout);
  return dir;
}
const post: SlackCall = { type: 'effect', provider: 'slack', verb: 'post', params: { channel: 'C1', text: 'hi' } };
const signal = () => new AbortController().signal;
function intent(dir: string) {
  return JSON.parse(readFileSync(receiptPath(dir, 'run', 'step') + '.pending', 'utf8')) as { absolutePath: string };
}
it('defaults to 60 seconds and rejects invalid budgets before writing', async () => {
  const dir = setup('');
  expect(helperReceiptTimeoutMs()).toBe(60_000);
  for (const value of ['0', '-1', 'NaN', '1.5', 'Infinity']) {
    vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', value);
    await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toThrow('positive integer');
  }
});
it('succeeds when the mount receipt arrives after the old three-second budget', async () => {
  const dir = setup('5000');
  const pending = slackWriteback(post, dir, 'run', 'step', signal());
  await vi.waitFor(() => expect(intent(dir).absolutePath).toBeDefined());
  await new Promise(resolve => setTimeout(resolve, 3200));
  writeFileSync(intent(dir).absolutePath, JSON.stringify({ externalId: '123.456' }));
  await expect(pending).resolves.toMatchObject({ ts: '123.456' });
}, 10_000);
it('names the pending GitHub write and resumes receipt polling without overwriting it', async () => {
  const dir = setup('20');
  const call = { type: 'effect' as const, provider: 'github', verb: 'comment',
    args: [{ owner: 'org', repo: 'repo', number: 1 }, 'hi'] };
  // Surface calls carry positional args, unlike YAML helper params.
  const { helperTransport } = await import('../src/helper-writeback.js');
  const request = { provider: 'github', resource: 'issue-comments', path: '/github/repos/org/repo/issues/1/comments',
    parameters: {}, body: { body: 'hi' } };
  const write = () => helperTransport(call, dir, 'run', 'step', signal()).transport.write(request);
  await expect(write()).rejects.toMatchObject({ code: 'helper_writeback_pending', writeId: 'run:step' });
  const path = intent(dir).absolutePath;
  const draft = readFileSync(path, 'utf8');
  const inode = statSync(path).ino;
  await expect(write()).rejects.toBeInstanceOf(HelperWritebackPending);
  expect(readFileSync(path, 'utf8')).toBe(draft);
  expect(statSync(path).ino).toBe(inode);
  writeFileSync(path, JSON.stringify({ id: '5738826838' }));
  await expect(write()).resolves.toMatchObject({ receipt: { id: '5738826838' }, deliveryStatus: 'confirmed' });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ id: '5738826838' });
});
it('does not treat a path and created stamp as provider delivery', async () => {
  const dir = setup('400');
  const call = { type: 'effect' as const, provider: 'github', verb: 'comment',
    args: [{ owner: 'org', repo: 'repo', number: 1 }, 'hi'] };
  const { helperTransport } = await import('../src/helper-writeback.js');
  const request = { provider: 'github', resource: 'issue-comments', path: '/github/repos/org/repo/issues/1/comments',
    parameters: {}, body: { body: 'hi' } };
  const pending = helperTransport(call, dir, 'run', 'step', signal()).transport.write(request);
  await vi.waitFor(() => expect(intent(dir).absolutePath).toBeDefined());
  writeFileSync(intent(dir).absolutePath, JSON.stringify({ path: request.path, created: '2020-01-01T00:00:00Z' }));
  await expect(pending).rejects.toMatchObject({ code: 'helper_writeback_pending' });
});
it('returns a provider id from the adapter without waiting out the receipt budget', async () => {
  const dir = setup('50');
  vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '1');
  await expect(helperWriteback({ type: 'effect', provider: 'github', verb: 'comment',
    args: [{ owner: 'org', repo: 'repo', number: 1 }, 'hi'] }, dir, 'run', 'step', signal()))
    .resolves.toMatchObject({ status: 'confirmed', receipt: { externalId: 'mock-step' } });
});
it('preserves the pending outcome through the authored helper wrapper', async () => {
  const dir = setup('20');
  await expect(helperWriteback({ type: 'effect', provider: 'github', verb: 'comment',
    args: [{ owner: 'org', repo: 'repo', number: 1 }, 'hi'] }, dir, 'run', 'step', signal()))
    .rejects.toMatchObject({ code: 'helper_writeback_pending', writeId: 'run:step' });
});
