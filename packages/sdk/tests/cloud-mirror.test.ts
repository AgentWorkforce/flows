import { describe, expect, it, vi } from 'vitest';
import {
  assembleTranscript, createRunMirror, readJournalEvents,
  MIRROR_BUSY_RETRIES, MIRROR_MAX_FINAL_STEPS,
} from '../src/cloud-mirror.js';
import { MirrorClient } from '../src/cloud-mirror-transport.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalReadError, type JournalEvent } from '../src/journal-reader.js';

type Call = { kind: string; body: unknown };

/** A Cloud stand-in: records every push, answers however the test says. */
function cloud(accept: (kind: string) => boolean = () => true) {
  const calls: Call[] = [];
  const client = {
    runId: 'cloud-run',
    runUrl: 'https://agentrelay.com/cloud/dashboard/workflow/cloud-run/runner',
    publishEvent: vi.fn(async (event: unknown) => { calls.push({ kind: 'event', body: event }); return accept('event'); }),
    publishSnapshot: vi.fn(async (snapshot: unknown) => { calls.push({ kind: 'snapshot', body: snapshot }); return accept('snapshot'); }),
    publishSteps: vi.fn(async (steps: unknown, omitted: unknown) => {
      calls.push({ kind: 'steps', body: { steps, omitted } });
      return accept('steps');
    }),
    putObject: vi.fn(async (key: string, bytes: Uint8Array) => {
      calls.push({ kind: 'object', body: { key, bytes: Buffer.from(bytes).toString('utf8') } });
      return accept('object');
    }),
    reportTerminal: vi.fn(async (status: unknown, result: unknown) => {
      calls.push({ kind: 'terminal', body: { status, result } });
      return accept('terminal');
    }),
  };
  return { client: client as unknown as MirrorClient, calls, spies: client };
}

let seq = 0;
function entry(partial: Partial<JournalEvent> & { entry_type: string; run_id: string }): JournalEvent {
  seq += 1;
  return { seq, segment_id: 1, step_id: null, attempt: null, at_ms: 1_700_000_000_000 + seq, payload: null, ...partial };
}

function rootJournal(runId: string, childRunId: string): JournalEvent[] {
  return [
    entry({ entry_type: 'run.spawned', run_id: runId, payload: { spec: { name: 'authored', steps: [] } } }),
    entry({
      entry_type: 'stream.appended',
      run_id: runId,
      payload: {
        stream: 'authored-steps',
        message: {
          index: 'relayflows.authored-step.v1',
          step: 'write', runId: childRunId, state: 'admitted', label: 'Write the patch',
        },
      },
    }),
  ];
}

function childJournal(runId: string, transcriptPath?: string): JournalEvent[] {
  return [
    entry({
      entry_type: 'run.spawned',
      run_id: runId,
      payload: { spec: { name: 'child', steps: [{ id: 'write', type: 'agent', after: [] }] } },
    }),
    entry({ entry_type: 'step.attempt.started', run_id: runId, step_id: 'write', attempt: 1, payload: {} }),
    entry({
      entry_type: 'step.completed',
      run_id: runId,
      step_id: 'write',
      attempt: 1,
      payload: {
        completionReason: 'success',
        disposition: 'step_done',
        budget: { tokens_in: 4, tokens_out: 2, dollars: '0.01' },
        ...(transcriptPath === undefined ? {} : {
          trajectory_tail: { transcript: { file: { path: transcriptPath, bytes_kept: 10 } } },
        }),
      },
    }),
    entry({ entry_type: 'run.completed', run_id: runId, payload: { completionReason: 'success' } }),
  ];
}

describe('createRunMirror', () => {
  it('reads only the journals this run owns', async () => {
    seq = 0;
    const { client } = cloud();
    const read = vi.fn(async (runId: string) => {
      if (runId === '01ROOT') return rootJournal('01ROOT', '01CHILD');
      if (runId === '01CHILD') return childJournal('01CHILD');
      throw new JournalReadError('run_not_found', 'not this run');
    });
    const mirror = createRunMirror({ client, dataDir: '/data', readJournal: read, env: {} });

    mirror.start('01ROOT');
    await mirror.finish({ status: 'completed', result: { ok: true, status: 'completed' } });

    // The root, and the one child its index names. A data directory holding a
    // hundred other runs contributes nothing.
    expect(read.mock.calls.map(call => call[0])).toEqual(['01ROOT', '01CHILD']);
  });

  it('publishes the child steps under the authored names the root gave them', async () => {
    seq = 0;
    const { client, calls } = cloud();
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      readJournal: async (runId: string) =>
        runId === '01ROOT' ? rootJournal('01ROOT', '01CHILD') : childJournal('01CHILD'),
    });

    mirror.start('01ROOT');
    await mirror.finish({ status: 'completed', result: { ok: true, status: 'completed' } });

    const snapshot = calls.find(call => call.kind === 'snapshot')!.body as { steps: Array<Record<string, unknown>> };
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({
      stepName: 'write', journalRunId: '01CHILD', state: 'done', label: 'Write the patch',
    });
    const report = calls.find(call => call.kind === 'steps')!.body as { steps: Array<Record<string, unknown>> };
    expect(report.steps[0]).toMatchObject({ stepName: 'write', status: 'completed', label: 'Write the patch' });
  });

  it('reports the terminal status last, after the transcripts and the final rows', async () => {
    seq = 0;
    const { client, calls } = cloud();
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      readJournal: async (runId: string) =>
        runId === '01ROOT' ? rootJournal('01ROOT', '01CHILD') : childJournal('01CHILD', '/data/runs/01CHILD/steps/write/attempt-1.transcript.jsonl'),
      readTranscript: async () => ({ bytes: Buffer.from('{"type":"result"}\n'), size: 18 }),
    });

    mirror.start('01ROOT');
    await mirror.finish({ status: 'completed', completionReason: 'success', result: { ok: true, status: 'completed', completionReason: 'success', runId: '01ROOT' }, log: ['RUN 01ROOT'] });

    // Cloud revokes the run's credential at the terminal transition, so every
    // write has to be in before it.
    const kinds = calls.map(call => call.kind);
    expect(kinds.at(-1)).toBe('terminal');
    expect(kinds.indexOf('object')).toBeLessThan(kinds.indexOf('steps'));
    const transcript = calls.find(call =>
      call.kind === 'object' && (call.body as { key: string }).key.endsWith('agent.log'))!;
    expect((transcript.body as { key: string }).key).toBe('write/agent.log');
    // Marked up in Cloud's own attempt vocabulary, so the dashboard renders a
    // mirrored transcript exactly as it renders a hosted one.
    expect((transcript.body as { bytes: string }).bytes)
      .toBe('{"type":"relayflow.attempt","attempt":1,"bytes":18,"truncated":false}\n{"type":"result"}\n');
    // The row now names the object, and only because the object landed.
    const report = calls.find(call => call.kind === 'steps')!.body as { steps: Array<Record<string, unknown>> };
    expect(report.steps[0]!.sandboxId).toBe('write');
    expect(calls.some(call => call.kind === 'object' && (call.body as { key: string }).key === 'runner.log')).toBe(true);
  });

  it('leaves the row without a transcript when the upload is refused', async () => {
    seq = 0;
    const { client, calls } = cloud(kind => kind !== 'object');
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      readJournal: async () => childJournal('01RUN', '/data/runs/01RUN/steps/write/attempt-1.transcript.jsonl'),
      readTranscript: async () => ({ bytes: Buffer.from('{}\n'), size: 3 }),
    });

    mirror.start('01RUN');
    await mirror.finish({ status: 'completed', result: { ok: true, status: 'completed' } });

    const report = calls.find(call => call.kind === 'steps')!.body as { steps: Array<Record<string, unknown>> };
    expect(report.steps[0]!.sandboxId).toBe('');
  });

  it('keeps a journal it could not read, rather than publishing an emptier view', async () => {
    seq = 0;
    const { client, calls } = cloud();
    let reads = 0;
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      intervalMs: 1,
      readJournal: async () => {
        reads += 1;
        if (reads === 1) return childJournal('01RUN');
        throw new JournalReadError('journal_busy', 'a writer was mid-flight');
      },
    });

    mirror.start('01RUN');
    await mirror.finish({ status: 'completed', result: { ok: true, status: 'completed' } });

    const report = calls.find(call => call.kind === 'steps')!.body as { steps: unknown[] };
    expect(report.steps).toHaveLength(1);
  });

  it('caps the final report and says how many steps it left out', async () => {
    seq = 0;
    const overCap = MIRROR_MAX_FINAL_STEPS + 12;
    const { client, calls } = cloud();
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      readJournal: async (runId: string) => [
        entry({
          entry_type: 'run.spawned',
          run_id: runId,
          payload: {
            spec: {
              name: 'wide',
              steps: Array.from({ length: overCap }, (_unused, index) => ({
                id: `step-${index}`, type: 'deterministic', after: [],
              })),
            },
          },
        }),
        ...Array.from({ length: overCap }, (_unused, index) => [
          entry({ entry_type: 'step.attempt.started', run_id: runId, step_id: `step-${index}`, attempt: 1, payload: {} }),
          entry({
            entry_type: 'step.completed',
            run_id: runId,
            step_id: `step-${index}`,
            attempt: 1,
            payload: { completionReason: 'success', disposition: 'step_done' },
          }),
        ]).flat(),
      ],
    });

    mirror.start('01RUN');
    await mirror.finish({ status: 'completed', result: { ok: true, status: 'completed' } });

    const report = calls.find(call => call.kind === 'steps')!.body as { steps: unknown[]; omitted: number };
    expect(report.steps).toHaveLength(MIRROR_MAX_FINAL_STEPS);
    // The count is by identity, so re-reading the same journal cannot inflate it.
    expect(report.omitted).toBe(12);
  });

  /**
   * The paths come out of a journal and this reader uploads whatever it is
   * handed, so "reads only this run's journals" has to cover the files too. An
   * unconfined path turns a crafted or corrupted journal into an
   * arbitrary-file upload.
   */
  it('refuses a transcript path outside the run\'s own tree', async () => {
    seq = 0;
    const { client, calls } = cloud();
    const diagnostic = vi.fn();
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      diagnostic,
      readJournal: async () => childJournal('01RUN', '/etc/passwd'),
      readTranscript: async () => ({ bytes: Buffer.from('root:x:0:0\n'), size: 11 }),
    });

    mirror.start('01RUN');
    await mirror.finish({ status: 'completed', result: { ok: true, status: 'completed' } });

    expect(calls.some(call => call.kind === 'object'
      && (call.body as { key: string }).key.endsWith('agent.log'))).toBe(false);
    expect(diagnostic.mock.calls.flat().join(' ')).toContain('outside');
    // The step row still lands; it just names no transcript.
    const report = calls.find(call => call.kind === 'steps')!.body as { steps: Array<Record<string, unknown>> };
    expect(report.steps[0]!.sandboxId).toBe('');
  });

  it('never throws out of finish, whatever Cloud answers', async () => {
    seq = 0;
    const { client } = cloud(() => false);
    const diagnostic = vi.fn();
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      diagnostic,
      readJournal: async () => { throw new Error('the disk is on fire'); },
    });

    mirror.start('01RUN');
    await expect(mirror.finish({ status: 'failed', error: 'step failed', result: { ok: false } })).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalled();
  });
});

/**
 * `walkJournal` refuses a torn snapshot as `journal_busy`, which on a live run
 * is the ordinary case rather than a fault. Without the retry a resume could
 * not read the spec it was about to register, gave up, and left the resumed
 * run off the dashboard entirely.
 */
describe('readJournalEvents', () => {
  it('retries a journal a writer was mid-flight in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirror-busy-'));
    await expect(readJournalEvents('01MISSING', dir, async () => {})).rejects.toMatchObject({
      code: 'run_not_found',
    });

    // The retry policy itself, over an injected reader: the real walk needs a
    // real journal, and what is pinned here is that `journal_busy` is retried
    // and nothing else is.
    let calls = 0;
    const flaky = async (): Promise<number> => {
      calls += 1;
      if (calls < 3) throw new JournalReadError('journal_busy', 'a writer was mid-flight');
      return calls;
    };
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await flaky();
        break;
      } catch (error) {
        if (!(error instanceof JournalReadError) || error.code !== 'journal_busy') throw error;
        if (attempts >= MIRROR_BUSY_RETRIES) throw error;
      }
    }
    expect(calls).toBe(3);
  });

  it('keeps a busy journal quiet rather than printing once per poll', async () => {
    seq = 0;
    const { client } = cloud();
    const diagnostic = vi.fn();
    const mirror = createRunMirror({
      client,
      dataDir: '/data',
      env: {},
      diagnostic,
      readJournal: async () => { throw new JournalReadError('journal_busy', 'a writer was mid-flight'); },
    });

    mirror.start('01RUN');
    await mirror.finish({ status: 'completed', result: { ok: true, status: 'completed' } });

    // A hot journal is what a running flow looks like; it is not news.
    expect(diagnostic.mock.calls.flat().join(' ')).not.toContain('journal_busy');
    expect(diagnostic.mock.calls.flat().join(' ')).not.toContain('mid-flight');
  });
});

describe('assembleTranscript', () => {
  const read = async (path: string) => {
    const body = `${path}\n`;
    return { bytes: Buffer.from(body), size: body.length };
  };

  it('orders attempts oldest-first, each behind its own marker', async () => {
    const assembled = await assembleTranscript(
      [{ attempt: 2, path: 'b' }, { attempt: 1, path: 'a' }], read,
    );
    expect(assembled.bytes.toString('utf8').split('\n').filter(Boolean)).toEqual([
      '{"type":"relayflow.attempt","attempt":1,"bytes":2,"truncated":false}',
      'a',
      '{"type":"relayflow.attempt","attempt":2,"bytes":2,"truncated":false}',
      'b',
    ]);
    expect(assembled).toMatchObject({ kept: 2, omitted: 0, truncated: false });
  });

  it('marks an attempt it had to drop rather than leaving the reader to count', async () => {
    const big = async () => ({ bytes: Buffer.alloc(400, 0x61), size: 400 });
    const assembled = await assembleTranscript(
      [{ attempt: 1, path: 'a' }, { attempt: 2, path: 'b' }], big, 600,
    );
    expect(assembled.omitted).toBe(1);
    expect(assembled.kept).toBe(1);
    expect(assembled.bytes.toString('utf8')).toContain('"type":"relayflow.attempt.omitted","attempt":1');
  });

  it('counts an attempt whose file has gone, instead of pretending it never ran', async () => {
    const missing = async () => { throw new Error('ENOENT'); };
    const assembled = await assembleTranscript([{ attempt: 1, path: 'a' }], missing);
    expect(assembled).toMatchObject({ kept: 0, omitted: 1 });
    expect(assembled.bytes.toString('utf8')).toContain('relayflow.attempt.omitted');
  });
});
