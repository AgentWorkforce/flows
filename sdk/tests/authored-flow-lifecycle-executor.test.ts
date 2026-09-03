import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type FlowHandle } from '@relayflows/surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import {
  kernelDialectError,
  sendOk,
  sendResult,
  sockPath,
  startLoopback,
} from './journal-client-loopback.js';

describe('authored flow lifecycle through the journal executor', () => {
  let path: string;
  let server: Server;
  let nextRun = 1;
  const startedSpecs: Record<string, unknown>[] = [];
  const stepByRun = new Map<string, { id: string; command: string }>();

  beforeAll(() => {
    path = sockPath();
    server = startLoopback(path, {
      hello: (ctx) => sendOk(ctx),
      'run.start': (ctx, params) => {
        const error = kernelDialectError(params.spec);
        if (error !== null) {
          ctx.send({ id: ctx.id, ok: false, error: { code: 'invalid_spec', message: error } });
          return;
        }
        const spec = params.spec as Record<string, unknown>;
        const step = (spec['steps'] as Record<string, unknown>[])[0]!;
        const runId = `lifecycle-run-${nextRun++}`;
        const command = step['command'] as string;
        startedSpecs.push(spec);
        stepByRun.set(runId, { id: step['id'] as string, command });
        sendResult(ctx, {
          run_id: runId,
          status: command === 'false' ? 'failed' : 'completed',
          completion_reason: command === 'false' ? 'step_failed' : 'success',
          completed_steps: 1,
        });
      },
      'journal.read': (ctx, params) => {
        const step = stepByRun.get(params.run_id as string)!;
        const failed = step.command === 'false';
        sendResult(ctx, {
          entries: [{
            entry_type: 'step.completed',
            step_id: step.id,
            payload: {
              completionReason: failed ? 'verification_failed' : 'success',
              output: failed ? null : { stdout_tail: '', stderr_tail: '', exit_code: 0 },
            },
          }],
        });
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });

  async function execute(handle: FlowHandle): Promise<Awaited<ReturnType<typeof executeAuthoredFlow>>> {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-lifecycle-test');
    try {
      return await executeAuthoredFlow(handle, client);
    } finally {
      client.close();
    }
  }

  function expectNoTerminalStart(startedBefore: number): void {
    expect(startedSpecs.slice(startedBefore)).not.toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('/complete-') }),
    );
  }

  it('refuses native resolver callbacks without starting terminal success', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('native-resolver-forgery', async (f) => {
      const deferred = Promise.withResolvers<string>();
      f.run('printf native-resolver').then(deferred.resolve, deferred.reject);
      await new Promise((resolve) => setTimeout(resolve, 100));
      f.done('success');
    }))).rejects.toMatchObject({ code: 'unawaited_step' });
    expectNoTerminalStart(startedBefore);
  });

  it.each(['resolve', 'all'] as const)(
    'refuses an ignored Promise.%s operation without terminal success',
    async (combinator) => {
      const startedBefore = startedSpecs.length;
      await expect(execute(flow(`ignored-${combinator}`, async (f) => {
        if (combinator === 'resolve') void Promise.resolve(f.run('printf ignored-resolve'));
        else void Promise.all([f.run('printf ignored-all-1'), f.run('printf ignored-all-2')]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        f.done('success');
      }))).rejects.toMatchObject({ code: 'unawaited_step' });
      expectNoTerminalStart(startedBefore);
    },
  );

  it('retains a swallowed Promise.resolve callback failure before terminal success', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('nested-callback-failure', async (f) => {
      await Promise.resolve(f.run('printf nested-callback'))
        .then(() => { throw new Error('nested callback was handled and forgotten'); })
        .catch(() => undefined)
        .finally(() => undefined);
      f.done('success');
    }))).rejects.toMatchObject({ code: 'operation_callback_failed' });
    expectNoTerminalStart(startedBefore);
  });

  it('retains root failure through a swallowed Promise.resolve callback chain', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('nested-root-failure', async (f) => {
      await Promise.resolve(f.run('false'))
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => undefined);
      f.done('success');
    }))).rejects.toMatchObject({
      code: 'step_failed',
      completionReason: 'verification_failed',
    });
    expectNoTerminalStart(startedBefore);
  });

  it('ignores forged Function.prototype.toString when refusing manual callbacks', async () => {
    const startedBefore = startedSpecs.length;
    await expect(execute(flow('forged-to-string', async (f) => {
      const originalToString = Function.prototype.toString;
      Function.prototype.toString = () => 'function () { [native code] }';
      try {
        f.run('printf forged-to-string').then(() => undefined, () => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        Function.prototype.toString = originalToString;
      }
      f.done('success');
    }))).rejects.toMatchObject({ code: 'unawaited_step' });
    expectNoTerminalStart(startedBefore);
  });

  it('preserves direct await, Promise.resolve, and Promise.all authoring', async () => {
    const result = await execute(flow('supported-awaits', async (f) => {
      await f.run('true');
      await Promise.resolve(f.run('true'));
      await Promise.all([f.run('true'), f.run('true')]);
      await Promise.all([Promise.resolve(f.run('true')), Promise.resolve(f.run('true'))]);
      f.done('success');
    }));
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.map((step) => step.id)).toEqual([
      'run-1',
      'run-2',
      'run-3',
      'run-4',
      'run-5',
      'run-6',
      'complete-7',
    ]);
  });
});
