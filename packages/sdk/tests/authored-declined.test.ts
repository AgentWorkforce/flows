import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type Ctx } from '@relayflows/surface';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

const marker = `printf '%s' '{"completionReason":"declined"}'`;
let path: string, server: Server;
let fault = '';
const steps = new Map<string, { id: string; type: string; command: string }>();
beforeAll(() => {
  path = sockPath();
  server = startLoopback(path, {
    hello: ctx => sendOk(ctx),
    'run.start': (ctx, params) => {
      const step = (params.spec as { steps: Array<{ id: string; type: string; command: string }> }).steps[0]!;
      if (step.id.startsWith('complete-') && fault === 'submission') {
        ctx.send({ id: ctx.id, ok: false, error: { code: 'journal_error', message: 'terminal write failed' } });
        return;
      }
      const runId = `child-${steps.size + 1}`;
      steps.set(runId, step);
      sendResult(ctx, { run_id: runId, status: step.command === 'false' ? 'failed' : 'completed',
        completion_reason: step.command === 'false' ? 'step_failed' : 'success', completed_steps: 1 });
    },
    'journal.read': (ctx, params) => {
      const step = steps.get(params.run_id as string)!;
      if (step.id.startsWith('complete-') && fault === 'read') {
        ctx.send({ id: ctx.id, ok: false, error: { code: 'journal_error', message: 'terminal read failed' } });
        return;
      }
      sendResult(ctx, { entries: fault === 'missing' ? [] : [{
        entry_type: 'step.completed', step_id: step.id,
        payload: { completionReason: step.command === 'false' ? 'verification_failed' : 'success',
          output: { stdout_tail: step.command === marker ? '{"completionReason":"declined"}' : 'checked',
            stderr_tail: '', exit_code: 0 } },
      }] });
    },
  });
});
beforeEach(() => { steps.clear(); fault = ''; });
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(path, { force: true });
});
async function execute(body: (f: Ctx) => Promise<void>) {
  const client = new JournalClient(path);
  await client.connect();
  await client.hello('declined-test');
  try { return await executeAuthoredFlow(flow('guard', body), client); }
  finally { client.close(); }
}

it.each([false, true])('journals a successful declined marker after prior work: %s', async prior => {
  let observed: string | undefined;
  const result = await execute(async f => {
    if (prior) observed = await f.run('printf checked');
    f.done('declined');
  });
  expect(observed).toBe(prior ? 'checked' : undefined);
  expect(result.completionReason).toBe('declined');
  expect(result.journalSteps).toEqual(prior ? [
    { id: 'run-1', runId: 'child-1', completionReason: 'success' },
    { id: 'complete-2', runId: 'child-2', completionReason: 'success' },
  ] : [{ id: 'complete-1', runId: 'child-1', completionReason: 'success' }]);
  expect([...steps.values()].at(-1)).toMatchObject({ type: 'deterministic', command: marker });
});

it.each(['submission', 'read', 'missing'])('fails closed on terminal %s failure', async failure => {
  fault = failure;
  await expect(execute(async f => f.done('declined'))).rejects.toThrow();
});

it.each([
  ['duplicate', 'duplicate_completion', async (f: Ctx) => { f.done('declined'); f.done('declined'); }],
  ['after completion', 'operation_after_completion', async (f: Ctx) => { f.done('declined'); await f.run('printf late'); }],
  ['unawaited', 'unawaited_step', async (f: Ctx) => { void f.run('printf ignored'); f.done('declined'); }],
  ['caught failure', 'step_failed', async (f: Ctx) => { try { await f.run('false'); } catch {} f.done('declined'); }],
  ['derived work', 'unsettled_derived_work', async (f: Ctx) => {
    const consumed = Promise.resolve(f.run('printf checked'));
    void consumed.then(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    await consumed;
    f.done('declined');
  }],
] as const)('cannot use declination to hide %s', async (_name, code, body) => {
  await expect(execute(body)).rejects.toMatchObject({ code });
  expect([...steps.values()].some(step => step.id.startsWith('complete-'))).toBe(false);
});

it.each(['canceled', 'budget_exceeded', 'invented'] as const)('still refuses %s', async reason => {
  await expect(execute(async f => f.done(reason as 'canceled'))).rejects.toMatchObject({
    code: 'unsupported_completion',
    message: expect.stringContaining(reason === 'invented' ? 'unknown completion reason' : 'kernel outcome'),
  });
  expect(steps.size).toBe(0);
});
