import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type Ctx, type FlowHeader } from '@relayflows/surface';
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
                stdout_tail: outputFor(step.command),
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

  it('refuses a workspace permission annotation f.agent cannot enforce, before contacting the journal', async () => {
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');

    for (const workspace of ['src/**: readonly', 'src/**: readwrite', 'src/**:readonly']) {
      await expect(executeAuthoredFlow(flow('workspace-permission-not-enforced', async (f) => {
        await f.agent('worker', { task: 'must not dispatch', workspace });
        f.done('success');
      }), disconnectedJournal)).rejects.toMatchObject({
        code: 'unsupported_workspace_permission',
      });
    }

    // A bare surface name (no permission annotation) is unaffected — this
    // suite's other f.agent cases already exercise the resolved path; this
    // one only needs to prove the annotation check does not over-match.
    await expect(executeAuthoredFlow(flow('workspace-bare-surface', async (f) => {
      await f.agent('worker', { task: 'x', workspace: 'repo' });
      f.done('success');
    }), disconnectedJournal)).rejects.not.toMatchObject({
      code: 'unsupported_workspace_permission',
    });
  });

  it('refuses non-string cli or model on f.agent options before contacting the journal', async () => {
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');

    // Both preflight and the type check throw `agent_cli_unresolved`
    // (matching the shared LLM code pattern) — the diagnostic message
    // distinguishes them so authors get an accurate error.
    for (const bad of [42, true, {}, []]) {
      await expect(executeAuthoredFlow(flow('agent-cli-not-string', async (f) => {
        await f.agent('worker', { task: 'x', cli: bad as unknown as string });
        f.done('success');
      }), disconnectedJournal)).rejects.toMatchObject({
        code: 'agent_cli_unresolved',
        message: expect.stringMatching(/f\.agent options\.cli must be a string when set/),
      });

      await expect(executeAuthoredFlow(flow('agent-model-not-string', async (f) => {
        await f.agent('worker', { task: 'x', model: bad as unknown as string });
        f.done('success');
      }), disconnectedJournal)).rejects.toMatchObject({
        code: 'agent_cli_unresolved',
        message: expect.stringMatching(/f\.agent options\.model must be a string when set/),
      });
    }
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

  it('rechecks terminal state when a precreated lazy step first starts', async () => {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-precreated-after-done-test');
    const startedBefore = startedSpecs.length;
    const cases = [
      flow('precreated-run-after-done', async (f) => {
        const pending = f.run('printf must-not-run');
        f.done('success');
        await pending;
      }),
      flow('precreated-llm-after-done', async (f) => {
        const pending = f.llm`must not run`;
        f.done('success');
        await pending;
      }),
      flow('precreated-agent-after-done', async (f) => {
        const pending = f.agent('worker', { task: 'must not run' });
        f.done('success');
        await pending;
      }),
    ];

    try {
      for (const handle of cases) {
        await expect(executeAuthoredFlow(handle, client)).rejects.toMatchObject({
          code: 'operation_after_completion',
          completionReason: 'success',
        });
      }
      expect(startedSpecs).toHaveLength(startedBefore);
    } finally {
      client.close();
    }
  });

  it('refuses manually chained work even when it settles before the body returns', async () => {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-manual-chain-test');

    const cases = [
      {
        handle: flow('manual-run-chain', async (f) => {
          f.run('printf manually-started').then(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 100));
          f.done('success');
        }),
        code: 'unawaited_step',
      },
      {
        handle: flow('manual-llm-chain', async (f) => {
          f.llm`requires a configured CLI`.then(undefined, () => undefined);
          await new Promise((resolve) => setTimeout(resolve, 100));
          f.done('success');
        }),
        code: 'llm_cli_unresolved',
      },
      // The LLM case now observes a real preflight failure. f.agent shares
      // that resolution seam; neither verb bypasses root-failure observation.
    ];

    try {
      for (const testCase of cases) {
        await expect(executeAuthoredFlow(testCase.handle, client)).rejects.toMatchObject({
          code: testCase.code,
        });
      }
    } finally {
      client.close();
    }
  });

  it('refuses forgotten work even when the body remains open long enough to settle it', async () => {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-forgotten-settled-test');
    const startedBefore = startedSpecs.length;

    try {
      await expect(executeAuthoredFlow(flow('forgotten-settled', async (f) => {
        f.run('printf forgotten-settled');
        await new Promise((resolve) => setTimeout(resolve, 100));
        f.done('success');
      }), client)).rejects.toMatchObject({ code: 'unawaited_step' });
      expect(startedSpecs).toHaveLength(startedBefore);
    } finally {
      client.close();
    }
  });

  it('retains root operation failures even when a derived rejection handler consumes them', async () => {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-consumed-rejection-test');

    const cases = [
      {
        handle: flow('consumed-run-rejection', async (f) => {
          f.run('false').then(undefined, () => 'consumed');
          await new Promise((resolve) => setTimeout(resolve, 100));
          f.done('success');
        }),
        code: 'step_failed',
      },
      {
        handle: flow('consumed-llm-rejection', async (f) => {
          f.llm`requires a configured CLI`.then(undefined, () => 'consumed');
          await new Promise((resolve) => setTimeout(resolve, 100));
          f.done('success');
        }),
        code: 'llm_cli_unresolved',
      },
      // A caught preflight rejection still belongs to the authored operation.
    ];

    try {
      for (const testCase of cases) {
        await expect(executeAuthoredFlow(testCase.handle, client)).rejects.toMatchObject({
          code: testCase.code,
        });
      }
    } finally {
      client.close();
    }
  });

  it('captures a rejected derived callback instead of leaking unhandled success', async () => {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-flow-derived-rejection-test');

    try {
      await expect(executeAuthoredFlow(flow('derived-rejection', async (f) => {
        f.run('printf callback-source')
          .then(() => 'first derived value')
          .then(() => {
            throw new Error('derived callback exploded');
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        f.done('success');
      }), client)).rejects.toMatchObject({ code: 'operation_callback_failed' });
    } finally {
      client.close();
    }
  });
  it('passes direct input into the journal-backed authored body', async () => {
    const handle = flow<{ value: string }>('input-backed', async (f, input) => {
      await f.run(`emit:${input.value}`);
      f.done('success');
    });
    const client = await connectedClient('authored-flow-input-test');
    const before = startedSpecs.length;

    try {
      await executeAuthoredFlow(handle, client, { value: 'from-direct-input' });
      expect(commandsSince(before)).toEqual(['emit:from-direct-input', ':']);
    } finally {
      client.close();
    }
  });

  it.each([
    ['truthiness', async (f: Ctx, value: string) => {
      if (value) await f.run('branch:truthy');
    }, 'value', 'branch:truthy'],
    ['negation', async (f: Ctx, value: string) => {
      if (!value) await f.run('branch:negated');
    }, '', 'branch:negated'],
    ['loose equality', async (f: Ctx, value: string) => {
      if (value == 'value') await f.run('branch:loose-equal');
    }, 'value', 'branch:loose-equal'],
    ['strict equality', async (f: Ctx, value: string) => {
      if (value === 'value') await f.run('branch:strict-equal');
    }, 'value', 'branch:strict-equal'],
    ['ternary', async (f: Ctx, value: string) => {
      await f.run(value ? 'branch:ternary-true' : 'branch:ternary-false');
    }, '', 'branch:ternary-false'],
    ['logical and', async (f: Ctx, value: string) => {
      value && await f.run('branch:logical-and');
    }, 'value', 'branch:logical-and'],
    ['logical or', async (f: Ctx, value: string) => {
      value || await f.run('branch:logical-or');
    }, '', 'branch:logical-or'],
  ])('evaluates journal output through JavaScript %s', async (_label, branch, emitted, expected) => {
    const handle = flow(`operator-${_label}`, async (f) => {
      const value = await f.run(`emit:${emitted}`);
      await branch(f, value);
      f.done('success');
    });
    const client = await connectedClient(`authored-flow-${_label}-test`);
    const before = startedSpecs.length;

    try {
      await executeAuthoredFlow(handle, client);
      expect(commandsSince(before)).toEqual([`emit:${emitted}`, expected, ':']);
    } finally {
      client.close();
    }
  });

  it('preserves separately awaited sibling ordering before the join', async () => {
    const handle = flow('separate-awaits', async (f) => {
      const left = f.run('emit:left');
      const right = f.run('emit:right');
      await left;
      await right;
      await f.run('joined');
      f.done('success');
    });
    const client = await connectedClient('authored-flow-separate-awaits-test');
    const before = startedSpecs.length;

    try {
      await executeAuthoredFlow(handle, client);
      expect(commandsSince(before)).toEqual(['emit:left', 'emit:right', 'joined', ':']);
    } finally {
      client.close();
    }
  });

  it('requires an explicit completion after journal-backed steps', async () => {
    const handle = flow('missing-completion', async (f) => {
      await f.run('emit:ran');
    });
    const client = await connectedClient('authored-flow-missing-completion-test');
    try {
      // Back to the code the original test asserted before #140 dropped it.
      //
      // Between the restoration and now this had to assert only the refusal's
      // class, because the executor answered `unawaited_step` -- it verified
      // operations before checking for a completion, and `isHandled` returns
      // false for every operation when there is no completion to trace from.
      // It named the step the author HAD awaited and said nothing about the
      // `done()` they forgot (#183). Fixed by checking the completion first,
      // so this can pin the code again.
      await expect(executeAuthoredFlow(handle, client)).rejects.toMatchObject({
        code: 'missing_completion',
      });
    } finally {
      client.close();
    }
  });

  /// Reaches `missing_completion` itself, which the case above cannot.
  ///
  /// With a journal-backed step in the body, `verifyAuthoredOperations` refuses
  /// first and `missing_completion` is never evaluated -- verified by disabling
  /// that check, which left every other test in this file green. A body with no
  /// operations to verify is what actually exercises it.
  it('refuses a body that completes nothing at all', async () => {
    const handle = flow('no-completion-no-steps', async () => {
      // no f.run, no f.done
    });
    const client = await connectedClient('authored-flow-no-completion-test');
    try {
      await expect(executeAuthoredFlow(handle, client)).rejects.toMatchObject({
        code: 'missing_completion',
      });
    } finally {
      client.close();
    }
  });

  async function connectedClient(name: string): Promise<JournalClient> {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello(name);
    return client;
  }

  function commandsSince(index: number): string[] {
    return startedSpecs.slice(index).map((spec) => {
      const steps = spec['steps'] as Record<string, unknown>[];
      return steps[0]!['command'] as string;
    });
  }
});

function outputFor(command: string): string {
  if (command.startsWith('emit:')) return command.slice('emit:'.length);
  return command === 'printf authored-journal-ok' ? 'authored-journal-ok' : '';
}
