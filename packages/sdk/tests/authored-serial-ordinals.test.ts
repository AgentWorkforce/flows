import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type FlowHandle } from '@relayflows/surface';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeAuthoredFlow, type ExecuteAuthoredFlowOptions } from '../src/authored-flow-executor.js';
import { serialOrdinals } from '../src/authored-serial-ordinals.js';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

/**
 * The serial ordinal guard against a loopback kernel. `journaled` is the
 * step index an earlier attempt left, as the root driver hands it to a
 * re-dispatched body (authored-root.ts); a first attempt passes none.
 */
describe('serial replay ordinal guard', () => {
  const ROOT = 'root-run';
  let path: string;
  let server: Server;
  let journaled: string[] = [];
  const started: string[] = [];
  const writes: unknown[] = [];
  const stepOf = new Map<string, string>();
  let nextRun = 1;

  beforeAll(() => {
    path = sockPath();
    server = startLoopback(path, {
      hello: (ctx) => sendOk(ctx),
      'run.start': (ctx, params) => {
        const spec = params.spec as { steps: Array<{ id: string; command: string }> };
        const step = spec.steps[0]!;
        const runId = `child-${nextRun++}`;
        started.push(step.id);
        stepOf.set(runId, step.id);
        writes.push({ verb: 'run.start', spec: params.spec, admission_key: params.admission_key });
        sendResult(ctx, { run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1 });
      },
      'journal.read': (ctx, params) => {
        if (params.run_id === ROOT) { sendResult(ctx, { entries: [] }); return; }
        sendResult(ctx, { entries: [{
          entry_type: 'step.completed', step_id: stepOf.get(params.run_id as string),
          payload: { completionReason: 'success', disposition: 'step_done',
            output: { exit_code: 0, stdout_tail: '', stderr_tail: '' } },
        }] });
      },
      'stream.read': (ctx) => sendResult(ctx, { messages: [], next_offset: 0 }),
      'stream.append': (ctx, params) => {
        writes.push({ verb: 'stream.append', stream: params.stream, message: params.message });
        sendResult(ctx, { offset: writes.length });
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });

  beforeEach(() => { journaled = []; started.length = 0; writes.length = 0; nextRun = 1; stepOf.clear(); });

  async function execute(handle: FlowHandle, options: ExecuteAuthoredFlowOptions = { rootRunId: ROOT, journaledSteps: journaled }) {
    const journal = new JournalClient(path, { requestTimeoutMs: 2000 });
    await journal.connect();
    await journal.hello('serial-ordinals-test');
    try {
      return await executeAuthoredFlow(handle, journal, undefined, options);
    } finally { journal.close(); }
  }

  it('refuses an f.run at an ordinal journaled as llm, before admitting it', async () => {
    journaled = ['llm-1'];
    await expect(execute(flow('kind-swap', async f => {
      await f.run('printf L');
      f.done('success');
    }))).rejects.toMatchObject({
      code: 'serial_replay_order_mismatch',
      message: expect.stringContaining('ordinal 1 is journaled as llm step "llm-1", but this resume reached it with run'),
    });
    expect(started).toEqual([]);
  });

  it('refuses an f.llm at an ordinal journaled as run, before any preflight', async () => {
    journaled = ['run-1'];
    await expect(execute(flow('kind-swap-reverse', async f => {
      await f.llm('prompt', { output: { type: 'object' } });
      f.done('success');
    }))).rejects.toMatchObject({
      code: 'serial_replay_order_mismatch',
      message: expect.stringContaining('ordinal 1 is journaled as run step "run-1", but this resume reached it with llm'),
    });
    expect(started).toEqual([]);
  });

  it('stays refused when the author catches the refusal', async () => {
    journaled = ['llm-1'];
    await expect(execute(flow('caught-refusal', async f => {
      try { await f.run('printf L'); } catch { /* author swallowed the refusal */ }
      try { await f.run('printf M'); } catch { /* must stay refused */ }
      f.done('success');
    }))).rejects.toMatchObject({ code: 'serial_replay_order_mismatch' });
    expect(started).toEqual([]);
  });

  it('does not start a step declared before the refusal and awaited after it', async () => {
    journaled = ['llm-2'];
    await expect(execute(flow('saved-step', async f => {
      const pending = f.run('printf P');
      try { await f.run('printf Q'); } catch { /* author swallowed the refusal */ }
      await pending;
      f.done('success');
    }))).rejects.toMatchObject({ code: 'serial_replay_order_mismatch' });
    expect(started).toEqual([]);
  });

  it('refuses the completion marker at an ordinal an earlier attempt gave a step', async () => {
    journaled = ['run-1', 'run-2'];
    await expect(execute(flow('fewer-steps', async f => {
      await f.run('printf A');
      f.done('success');
    }))).rejects.toMatchObject({
      code: 'serial_replay_order_mismatch',
      message: expect.stringContaining('ordinal 2 is journaled as run step "run-2", but this resume reached it with complete'),
    });
    expect(started).toEqual(['run-1']);
  });

  it('writes exactly what a first run writes when the resume follows the journaled order', async () => {
    const body = flow('in-order', async f => {
      await f.run('printf A');
      await Promise.all([f.run('printf B'), f.run('printf C')]);
      f.done('success');
    });
    // A first attempt: the driver hands over no index at all.
    await expect(execute(body, { rootRunId: ROOT })).resolves.toMatchObject({ completionReason: 'success' });
    const first = JSON.stringify(writes);
    expect(started).toEqual(['run-1', 'run-2', 'run-3', 'complete-4']);
    journaled = ['run-1', 'run-2', 'run-3'];
    writes.length = 0; started.length = 0; nextRun = 1; stepOf.clear();
    await expect(execute(body)).resolves.toMatchObject({ completionReason: 'success' });
    // Same admissions, same specs, same index records, byte for byte.
    expect(JSON.stringify(writes)).toBe(first);
  });

  it('leaves parallel roots to their causal identities', async () => {
    journaled = ['llm-1'];
    await expect(execute(flow('parallel-unaffected', async f => {
      await f.run('printf W');
      const a = async () => { await f.run('printf A'); };
      const b = async () => { await f.run('printf B'); };
      await Promise.all([a(), b()]);
      f.done('success');
    }), { rootRunId: ROOT, executionMode: 'parallel', journaledSteps: journaled })).resolves.toMatchObject({ completionReason: 'success' });
    expect(started[0]).toBe('run-1');
    expect(started).toHaveLength(4);
  });

  it('reads only the ordinals journaled directly under a body prefix', () => {
    const steps = ['run-1', 'llm-2', 'run-2.gate', 'dispatch-3--run-1', 'dispatch-3--dispatch-2--llm-1',
      `slack-01M5TYGZ0TSXD62DHZC1TYBQNM-4`, 'complete-5', 'run-after-abc-1x'];
    expect([...serialOrdinals(steps, '')].map(([ordinal, { kind }]) => [ordinal, kind])).toEqual([
      [1, 'run'], [2, 'llm'], [4, 'slack-01M5TYGZ0TSXD62DHZC1TYBQNM'], [5, 'complete'],
    ]);
    expect([...serialOrdinals(steps, 'dispatch-3--')].map(([ordinal, { kind }]) => [ordinal, kind]))
      .toEqual([[1, 'run']]);
  });
});
