import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { JournalClient, JournalRequestTimeoutError } from '../src/journal-client.js';
import { HELLO_SPEC, sendOk, sendResult, sockPath, startLoopback, type LoopbackHandlers } from './journal-client-loopback.js';

const clients: JournalClient[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function setup(handlers: LoopbackHandlers, budget: number | undefined = 1000) {
  const path = sockPath();
  const server = startLoopback(path, { hello: sendOk, ...handlers }, { serialize: true });
  servers.push(server);
  await once(server, 'listening');
  const client = new JournalClient(path, { requestTimeoutMs: 50, readBudgetMs: budget });
  clients.push(client);
  await client.connect();
  return client;
}

it('serves a bounded read while an unbounded command is in flight', async () => {
  let started!: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const client = await setup({
    'run.start': async ctx => { started(); await sleep(100); sendResult(ctx, { status: 'completed' }); },
    'run.get': ctx => sendResult(ctx, { status: 'running' }),
  });
  let commandDone = false;
  const command = client.runStart(HELLO_SPEC).then(result => { commandDone = true; return result; });
  await inFlight;
  expect(await client.runGet('run')).toMatchObject({ status: 'running' });
  expect(commandDone).toBe(false);
  await command;
});

it('retries a read with a fresh id and ignores the late first reply', async () => {
  const ids: string[] = [];
  let first: Parameters<typeof sendResult>[0];
  const client = await setup({ 'run.get': ctx => {
    ids.push(ctx.id);
    if (ids.length === 1) first = ctx;
    else { sendResult(first, { status: 'stale' }); sendResult(ctx, { status: 'completed' }); }
  } });
  expect(await client.runGet('run')).toMatchObject({ status: 'completed' });
  expect(new Set(ids).size).toBe(2);
});

it('never retries mutating verbs', async () => {
  let writes = 0;
  const client = await setup({ 'stream.append': () => { writes += 1; } });
  await expect(client.streamAppend('run', 'stream', {})).rejects.toMatchObject({
    verb: 'stream.append', attempts: 1, message: 'journal client: stream.append timed out after 50ms',
  });
  expect(writes).toBe(1);
});

it('exhausts a total read budget with a typed diagnostic', async () => {
  const client = await setup({ 'run.get': () => {} }, 250);
  const error = await client.runGet('run').catch(error => error);
  expect(error).toBeInstanceOf(JournalRequestTimeoutError);
  expect(error.attempts).toBeGreaterThan(1);
  expect(error.message).toContain('read budget 250ms');
  expect(error.message).toContain('CPU load');
});

it('keeps interactive reads single-shot by default', async () => {
  let reads = 0;
  // Explicitly omit the opt-in.
  const client = await setup({ 'run.get': () => { reads += 1; } }, 0);
  client.close();
  const interactive = new JournalClient(client.socketPath, { requestTimeoutMs: 10 });
  clients.push(interactive);
  await interactive.connect();
  await expect(interactive.runGet('run')).rejects.toMatchObject({ attempts: 1, readBudgetMs: undefined });
  expect(reads).toBe(1);
});

it('serializes concurrent reads and stops queued reads on close', async () => {
  let reads = 0;
  let received!: () => void;
  const entered = new Promise<void>(resolve => { received = resolve; });
  const client = await setup({ 'run.get': () => { reads += 1; received(); } });
  const results = Promise.allSettled(Array.from({ length: 8 }, () => client.runGet('run')));
  await entered;
  client.close();
  expect((await results).every(result => result.status === 'rejected')).toBe(true);
  expect(reads).toBe(1);
});

it('does not retry protocol rejections', async () => {
  let reads = 0;
  const client = await setup({ 'run.get': ctx => {
    reads += 1;
    ctx.send({ id: ctx.id, ok: false, error: { code: 'run_not_found', message: 'absent' } });
  } });
  await expect(client.runGet('absent')).rejects.toMatchObject({ code: 'run_not_found' });
  expect(reads).toBe(1);
});

it('a recovered read timeout does not become an authored callback failure', async () => {
  const { flow } = await import('@relayflows/surface');
  const { executeAuthoredFlow } = await import('../src/authored-flow-executor.js');
  let reads = 0;
  const client = await setup({
    'run.start': (ctx, params) => sendResult(ctx, { run_id: (params['spec'] as { steps: Array<{ id: string }> }).steps[0]!.id, status: 'completed', completion_reason: 'success', completed_steps: 1 }),
    'journal.read': (ctx, params) => {
      if (++reads === 1) return;
      sendResult(ctx, { entries: [{ seq: 1, run_id: params['run_id'], step_id: params['run_id'], entry_type: 'step.completed',
        payload: { completionReason: 'success', output: { stdout_tail: 'ok', exit_code: 0 } } }] });
    },
  });
  const result = await executeAuthoredFlow(flow('retried-read', async f => {
    await f.run('echo ok');
    f.done('success');
  }), client, undefined);
  expect(result.completionReason).toBe('success');
  expect(reads).toBe(3);
});

it('falls back to the primary connection if reader setup is refused', async () => {
  const client = await setup({
    hello: ctx => ctx.send({ id: ctx.id, ok: false, error: { code: 'busy', message: 'reader unavailable' } }),
    'run.get': ctx => sendResult(ctx, { status: 'completed' }),
  });
  expect(await client.runGet('run')).toMatchObject({ status: 'completed' });
});

it.each(['run.get', 'journal.read', 'stream.read', 'subscription.inspect'] as const)('retries only the allowlisted read %s', async verb => {
  let attempts = 0;
  const client = await setup({ [verb]: ctx => { if (++attempts === 2) sendResult(ctx, {}); } });
  const result = verb === 'run.get' ? client.runGet('run')
    : verb === 'journal.read' ? client.journalRead('run', 1)
    : verb === 'stream.read' ? client.streamRead('run', 'stream', 0)
    : client.subscriptionInspect({ run_id: 'run', subscription_id: 'subscription' });
  await result;
  expect(attempts).toBe(2);
});
