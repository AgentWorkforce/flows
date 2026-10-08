import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { waitForRunningStep } from '../src/cli/running-step.js';
import { isReadInterruption } from '../src/cli/journal-timeout.js';
import { AuthoredFlowExecutionError } from '../src/authored-flow-error.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

it('uses pushes for completion with lease-cadence reads and releases its watcher', async () => {
  let reads = 0;
  let watchClosed = false;
  const path = sockPath();
  const server = startLoopback(path, {
    hello: sendOk,
    'run.watch': (ctx, params) => {
      const entry = (run: string, type: string) => ctx.send({ event: 'entry', data: {
        run_id: run, step_id: 'step', entry_type: type,
      } });
      // An older failed attempt in replay must not finish the current one.
      entry('run', 'step.completed');
      entry('run', 'step.attempt.started');
      sendResult(ctx, {});
      entry('other-run', 'step.completed');
      setTimeout(() => entry(String(params['run_id']), 'step.completed'), 2100);
      ctx.socket.once('close', () => { watchClosed = true; });
    },
    'run.get': ctx => { reads++; sendResult(ctx, { steps: { step: {
      state: 'running', lease_deadline_ms: Date.now() + 30_000,
    } } }); },
  });
  await once(server, 'listening');
  const client = new JournalClient(path);
  try {
    await client.connect();
    const start = performance.now();
    await waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, {});
    expect(performance.now() - start).toBeGreaterThan(2000);
    expect(reads).toBeLessThanOrEqual(1);
    await sleep(10);
    expect(watchClosed).toBe(true);
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('cancels a pending watch registration and removes its connection', async () => {
  const path = sockPath();
  let registered!: () => void;
  const registration = new Promise<void>(resolve => { registered = resolve; });
  const server = startLoopback(path, { hello: sendOk, 'run.watch': () => registered() });
  await once(server, 'listening');
  const client = new JournalClient(path);
  const controller = new AbortController();
  try {
    await client.connect();
    const waiting = waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, { signal: controller.signal });
    const rejected = expect(waiting).rejects.toThrow('was canceled');
    await registration;
    controller.abort();
    await rejected;
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('cancels promptly while a lease snapshot read is in flight', async () => {
  const path = sockPath();
  let reading!: () => void;
  const readStarted = new Promise<void>(resolve => { reading = resolve; });
  const server = startLoopback(path, {
    hello: sendOk,
    'run.watch': ctx => sendResult(ctx, {}),
    // The daemon never answers the snapshot: only cancellation can end the wait.
    'run.get': () => reading(),
  });
  await once(server, 'listening');
  const client = new JournalClient(path, { readBudgetMs: 300_000 });
  const controller = new AbortController();
  try {
    await client.connect();
    const waiting = waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, { signal: controller.signal });
    const outcome = waiting.then(() => 'returned', error => error);
    await readStarted;
    controller.abort();
    const settled = await Promise.race([outcome, sleep(200).then(() => 'still waiting')]);
    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).message).toContain('was canceled');
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('cancelling during the watch handshake leaves no unhandled rejection', async () => {
  const path = sockPath();
  let greeted!: () => void;
  const hello = new Promise<void>(resolve => { greeted = resolve; });
  const server = startLoopback(path, { hello: () => greeted() }); // never answers the watch hello
  await once(server, 'listening');
  const client = new JournalClient(path);
  const controller = new AbortController();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await client.connect();
    const waiting = waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, { signal: controller.signal });
    const rejected = expect(waiting).rejects.toThrow('was canceled');
    await hello;
    controller.abort();
    await rejected;
    await sleep(50);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    client.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('treats a watch connection lost during registration as a read interruption', async () => {
  const path = sockPath();
  let hellos = 0;
  const server = startLoopback(path, {
    hello: ctx => { hellos += 1; sendOk(ctx); },
    'run.watch': ctx => { ctx.socket.destroy(); }, // registered hello, then the socket drops
  });
  await once(server, 'listening');
  const client = new JournalClient(path);
  try {
    await client.connect();
    const error = await waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, {})
      .catch(caught => caught);
    expect(error).toBeInstanceOf(AuthoredFlowExecutionError);
    expect(error.code).toBe('daemon_unresponsive');
    expect(isReadInterruption(error)).toBe(true);
    expect(hellos).toBe(1);
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('a completion push ends the wait without waiting out an in-flight snapshot', async () => {
  const path = sockPath();
  let push!: () => void;
  const server = startLoopback(path, {
    hello: sendOk,
    'run.watch': (ctx, params) => {
      sendResult(ctx, {});
      push = () => ctx.send({ event: 'entry', data: { run_id: String(params['run_id']), step_id: 'step', entry_type: 'step.completed' } });
    },
    // The snapshot never answers; the completion arrives while it is in flight.
    'run.get': () => push(),
  });
  await once(server, 'listening');
  const client = new JournalClient(path, { readBudgetMs: 300_000 });
  try {
    await client.connect();
    const waiting = waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, {});
    const outcome = await Promise.race([waiting.then(() => 'returned'), sleep(3_000).then(() => 'still waiting')]);
    expect(outcome).toBe('returned');
    expect(await client.runGet('run', { signal: AbortSignal.timeout(50) }).catch(error => error.name)).toBe('TimeoutError');
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('a completion that aborts the snapshot is not an error even if a retry starts at once', async () => {
  const path = sockPath();
  let push!: () => void;
  const server = startLoopback(path, {
    hello: sendOk,
    'run.watch': (ctx, params) => {
      sendResult(ctx, {});
      const entry = (type: string) => ctx.send({ event: 'entry', data: { run_id: String(params['run_id']), step_id: 'step', entry_type: type } });
      push = () => { entry('step.completed'); entry('step.attempt.started'); };
    },
    'run.get': () => push(),
  });
  await once(server, 'listening');
  const client = new JournalClient(path, { readBudgetMs: 300_000 });
  try {
    await client.connect();
    const outcome = await Promise.race([
      waitForRunningStep(client, 'run', { id: 'step', type: 'agent', leaseDeadlineMs: Date.now() + 30_000 }, {})
        .then(() => 'returned', error => `threw: ${error.message}`),
      sleep(3_000).then(() => 'still waiting'),
    ]);
    expect(outcome).toBe('returned');
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
