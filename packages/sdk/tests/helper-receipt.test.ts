import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { slackWriteback, type SlackCall } from '../src/slack-writeback.js';
import { helperReceiptTimeoutMs, isHelperReceipt, pendingWritePath, receiptWriteback } from '../src/helper-receipt.js';
import { checkProviderHelpers } from '../src/slack-preflight.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { flow } from '@relayflows/surface';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'helper-receipt-')); dirs.push(dir);
  mkdirSync(join(dir, 'slack'));
  vi.stubEnv('RELAYFILE_MOUNT_PATH', dir); vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '');
  return dir;
}
const post: SlackCall = { type: 'effect', provider: 'slack', verb: 'post', params: { channel: 'C1', text: 'hello' } };
const signal = () => new AbortController().signal;
async function accepted(dir: string) {
  const file = pendingWritePath(dir, 'run', 'step');
  await vi.waitFor(() => expect(() => readFileSync(file)).not.toThrow());
  const record = JSON.parse(readFileSync(file, 'utf8'));
  return { ...record, path: join(dir, record.relayPath) };
}

it('collects a real mount receipt later than adapter-core’s old 3s budget', async () => {
  const dir = setup(); vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', '5000');
  const write = slackWriteback(post, dir, 'run', 'step', signal());
  const record = await accepted(dir);
  await new Promise(resolve => setTimeout(resolve, 3500));
  writeFileSync(record.path, JSON.stringify({ externalId: '123.456' }));
  await expect(write).resolves.toMatchObject({ ts: '123.456' });
}, 8000);

it('names an accepted write at budget exhaustion and waits again without rewriting it', async () => {
  const dir = setup(); vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', '10');
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toMatchObject({ code: 'helper_writeback_pending', writeId: 'run:step' });
  const record = await accepted(dir);
  // The daemon may update a still-pending draft; replay must not overwrite it.
  writeFileSync(record.path, JSON.stringify({ queued: true }));
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toMatchObject({ code: 'helper_writeback_pending' });
  expect(JSON.parse(readFileSync(record.path, 'utf8'))).toEqual({ queued: true });
  writeFileSync(record.path, JSON.stringify({ externalId: 'done' }));
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).resolves.toMatchObject({ ts: 'done' });
  expect(readdirSync(join(dir, 'slack/channels/C1/messages'))).toHaveLength(1);
});

it('aborts promptly and replays the accepted write against a relocated mount', async () => {
  const dir = setup(); const controller = new AbortController();
  const write = slackWriteback(post, dir, 'run', 'step', controller.signal);
  const rejection = expect(write).rejects.toThrow();
  const record = await accepted(dir); controller.abort(); await rejection;
  const next = setup(); renameSync(join(dir, 'slack'), join(next, 'slack'));
  writeFileSync(join(next, record.relayPath), JSON.stringify({ externalId: 'moved' }));
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).resolves.toMatchObject({ ts: 'moved' });
});

it('does not overwrite a receipt even if death preceded the accepted record', async () => {
  const dir = setup(); vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', '1');
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toThrow('pending');
  const record = await accepted(dir); rmSync(pendingWritePath(dir, 'run', 'step'));
  writeFileSync(record.path, JSON.stringify({ externalId: 'delivered' }));
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).resolves.toMatchObject({ ts: 'delivered' });
  expect(JSON.parse(readFileSync(record.path, 'utf8'))).toEqual({ externalId: 'delivered' });
});

it('rejects mismatched computed paths and mount escapes before a write', async () => {
  const dir = setup(); vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', '1');
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toThrow('pending');
  await expect(slackWriteback({ ...post, params: { channel: 'C2', text: 'changed' } }, dir, 'run', 'step', signal())).rejects.toThrow('computed draft path');
  await expect(receiptWriteback(dir, 'slack', 'write.messages', '/../escape.json', {}, dir, 'other', 'step', signal())).rejects.toThrow('escapes');
});

it('pins the @relayfile/adapter-core 0.6.2 receipt predicate, excluding unchanged drafts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../node_modules/@relayfile/adapter-core/package.json', import.meta.url), 'utf8'));
  expect(pkg.version).toBe('0.6.2');
  for (const receipt of [{ created: 'yes' }, { path: '/p' }, { id: '1' }, { externalId: '2' }, { merged: false }, { merged: 'yes' }]) {
    expect(isHelperReceipt(receipt, {})).toBe(true);
    expect(isHelperReceipt(receipt, receipt)).toBe(false);
  }
  for (const value of [null, [], 'id', { id: 1 }, { queued: true }]) expect(isHelperReceipt(value, {})).toBe(false);
});

it('defaults to 60s and accepts only positive safe integer budgets', () => {
  expect(helperReceiptTimeoutMs({})).toBe(60_000);
  expect(helperReceiptTimeoutMs({ RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS: '600000' })).toBe(600000);
  for (const raw of ['', ' ', '0', '-1', '1.5', 'Infinity', 'oops', '1e3', '9007199254740992']) {
    expect(() => helperReceiptTimeoutMs({ RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS: raw })).toThrow('positive integer');
  }
});

it('refuses malformed budgets before the authored body or journal is entered', async () => {
  setup(); vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', 'bad');
  expect(checkProviderHelpers({ header: { tools: { slack: true } } }).diagnostics[0]).toMatchObject({ severity: 'refusal', kind: 'budget_syntax_invalid' });
  let entered = false;
  await expect(executeAuthoredFlow(flow('invalid-budget', async f => {
    entered = true; await f.slack.post('C1', 'hi'); f.done('success');
  }), new JournalClient('/must-not-connect'))).rejects.toMatchObject({ code: 'budget_syntax_invalid' });
  expect(entered).toBe(false);
});


it('never treats a pre-existing canonical item as the receipt for its new update', async () => {
  const dir = setup();
  vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', '1');
  const path = '/slack/item.json';
  writeFileSync(join(dir, path), JSON.stringify({ id: 'old-item' }));
  await expect(receiptWriteback(dir, 'slack', 'write.messages', path,
    { text: 'update', idempotencyKey: 'run:step' }, dir, 'run', 'step', signal())).rejects.toThrow('pending');
  expect(JSON.parse(readFileSync(join(dir, path), 'utf8'))).toMatchObject({ text: 'update' });
});

it('fails closed on a corrupt accepted record instead of posting again', async () => {
  const dir = setup(); vi.stubEnv('RELAYFLOW_HELPER_RECEIPT_TIMEOUT_MS', '1');
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toThrow('pending');
  const record = await accepted(dir);
  writeFileSync(record.path, JSON.stringify({ queued: true }));
  writeFileSync(pendingWritePath(dir, 'run', 'step'), 'null');
  await expect(slackWriteback(post, dir, 'run', 'step', signal())).rejects.toThrow('Invalid helper accepted-write record');
  expect(JSON.parse(readFileSync(record.path, 'utf8'))).toEqual({ queued: true });
});
