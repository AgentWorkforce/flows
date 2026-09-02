import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type FlowHeader } from '@relayflows/surface';
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

describe('authored flow journal executor', () => {
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
        const runId = `authored-run-${nextRun++}`;
        startedSpecs.push(spec);
        stepByRun.set(runId, {
          id: step['id'] as string,
          command: step['command'] as string,
        });
        const failed = step['command'] === 'false';
        sendResult(ctx, {
          run_id: runId,
          status: failed ? 'failed' : 'completed',
          completion_reason: failed ? 'step_failed' : 'success',
          completed_steps: 1,
        });
      },
      'journal.read': (ctx, params) => {
        const runId = params.run_id as string;
        const step = stepByRun.get(runId)!;
        const failed = step.command === 'false';
        sendResult(ctx, {
          entries: [{
            entry_type: 'step.completed',
            step_id: step.id,
            payload: {
              completionReason: failed ? 'verification_failed' : 'success',
              disposition: 'step_done',
              output: failed ? null : {
                exit_code: 0,
                stdout_tail: step.command === 'printf authored-journal-ok'
                  ? 'authored-journal-ok'
                  : '',
                stderr_tail: '',
              },
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

  it('lowers an imported .flow.ts run and completion through the journal protocol', async () => {
    const authoredModule = await import('./fixtures/runtime-bridge.flow.js');
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-test');

    try {
      const result = await executeAuthoredFlow(authoredModule.default, client);

      expect(result).toEqual({
        name: 'runtime-bridge-fixture',
        completionReason: 'success',
        journalSteps: [
          { id: 'run-1', runId: 'authored-run-1', completionReason: 'success' },
          { id: 'complete-2', runId: 'authored-run-2', completionReason: 'success' },
        ],
      });
      expect(startedSpecs).toHaveLength(2);
      expect(startedSpecs[0]).toMatchObject({
        version: '0.1.0',
        name: 'runtime-bridge-fixture/run-1',
        steps: [{
          id: 'run-1',
          type: 'deterministic',
          command: 'printf authored-journal-ok',
          depends_on: [],
          verification: {},
        }],
      });
      expect(startedSpecs[1]).toMatchObject({
        name: 'runtime-bridge-fixture/complete-2',
        steps: [{ id: 'complete-2', type: 'deterministic', command: ':' }],
      });
    } finally {
      client.close();
    }
  });

  it('surfaces the closed journal reason when a lowered run fails', async () => {
    const handle = flow('authored-failure', async (f) => {
      await f.run('false');
      f.done('success');
    });
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-failure-test');

    try {
      await expect(executeAuthoredFlow(handle, client)).rejects.toMatchObject({
        code: 'step_failed',
        completionReason: 'verification_failed',
        runId: 'authored-run-3',
      });
    } finally {
      client.close();
    }
  });

  it('refuses unsupported surface features before bypassing the journal', async () => {
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');

    await expect(executeAuthoredFlow(flow(
      'header-not-lowered',
      { identity: 'principal' },
      async (f) => f.done('success'),
    ), disconnectedJournal)).rejects.toMatchObject({ code: 'unsupported_header' });

    await expect(executeAuthoredFlow(flow('gate-not-lowered', async (f) => {
      await f.run('true').gate(Boolean);
      f.done('success');
    }), disconnectedJournal)).rejects.toMatchObject({ code: 'unsupported_gate' });
  });

  it('rejects invalid raw headers before the executor can contact the journal', async () => {
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');

    await expect((async () => executeAuthoredFlow(flow(
      'misspelled-header',
      { identitty: 'principal' } as FlowHeader,
      async (f) => f.done('success'),
    ), disconnectedJournal))()).rejects.toThrow(
      'flow "misspelled-header" header: unknown field "identitty"',
    );

    await expect((async () => executeAuthoredFlow(flow(
      'invalid-nested-header',
      { tools: { mcp: ['github'], typo: true } } as unknown as FlowHeader,
      async (f) => f.done('success'),
    ), disconnectedJournal))()).rejects.toThrow(
      'flow "invalid-nested-header" header.tools: unknown field "typo"',
    );
  });

  it('refuses every unawaited thenable-producing verb before terminal success', async () => {
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    const cases = [
      flow('unawaited-run', async (f) => {
        f.run('false');
        f.done('success');
      }),
      flow('unawaited-llm', async (f) => {
        f.llm`must not vanish`;
        f.done('success');
      }),
      flow('unawaited-agent', async (f) => {
        f.agent('worker', { task: 'must not vanish' });
        f.done('success');
      }),
    ];

    for (const handle of cases) {
      await expect(executeAuthoredFlow(handle, disconnectedJournal)).rejects.toMatchObject({
        code: 'unawaited_step',
      });
    }
  });

  it('refuses unsupported promise verbs synchronously even when their results are ignored', async () => {
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    const cases = [
      flow('unawaited-human', async (f) => {
        f.human('approve?', { to: 'owner' });
        f.done('success');
      }),
      flow('unawaited-dispatch', async (f) => {
        f.dispatch('child', {});
        f.done('success');
      }),
      flow('unawaited-cloud', async (f) => {
        f.cloud.workers.list({ workspaceId: 'workspace', as: 'principal' });
        f.done('success');
      }),
    ];

    for (const handle of cases) {
      await expect(executeAuthoredFlow(handle, disconnectedJournal)).rejects.toMatchObject({
        code: 'unsupported_verb',
      });
    }
  });

  it('treats done as terminal and rejects later operations before journal contact', async () => {
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    await expect(executeAuthoredFlow(flow('after-done', async (f) => {
      f.done('success');
      await f.run('must-not-run');
    }), disconnectedJournal)).rejects.toMatchObject({
      code: 'operation_after_completion',
      completionReason: 'success',
    });
  });
});
