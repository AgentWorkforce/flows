import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow } from '@relayflows/surface';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { AuthoredHumanParked } from '../src/authored-flow-error.js';
import { humanAnswerPayload, parseHumanAnswer, readOpenHumanWaits } from '../src/authored-human.js';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

/**
 * `f.human` against a loopback kernel. The ROOT journal is scripted per test:
 * what `journal.read` returns for the root run is the only thing that decides
 * whether the body parks or continues, exactly as with the real daemon.
 */
describe('f.human lowering', () => {
  const ROOT = 'root-run';
  let path: string;
  let server: Server;
  let rootEntries: Array<Record<string, unknown>> = [];
  const started: Array<{ id: string; command: string; admissionKey?: string; gate?: { id: string; command: string } }> = [];
  const failedRuns = new Set<string>();
  let gateVerdict: 'pass' | 'fail' = 'pass';
  const outputs = new Map<string, string>();
  const stepOf = new Map<string, string>();
  let nextRun = 1;
  let streamAppends = 0;

  beforeAll(() => {
    path = sockPath();
    server = startLoopback(path, {
      hello: (ctx) => sendOk(ctx),
      'run.start': (ctx, params) => {
        const spec = params.spec as { steps: Array<{ id: string; command: string }> };
        const step = spec.steps[0]!;
        const runId = `child-${nextRun++}`;
        // A named gate lowers as a second `<id>.gate` step whose command embeds
        // the pattern (named-gate-lowering.ts); record it so a test can prove
        // the gate reached the spec.
        const gateStep = spec.steps[1];
        started.push({ id: step.id, command: step.command, ...(typeof params.admission_key === 'string' ? { admissionKey: params.admission_key } : {}),
          ...(gateStep === undefined ? {} : { gate: { id: gateStep.id, command: gateStep.command } }) });
        // The fake "executes" printf '%s' '<literal>' by unquoting the literal.
        const printed = /^printf '%s' '((?:[^']|'\\'')*)'$/.exec(step.command)?.[1]?.replaceAll("'\\''", "'") ?? '';
        outputs.set(runId, printed);
        stepOf.set(runId, step.id);
        // The fake cannot run the gate's embedded engine; the test says how it judges.
        const failed = gateStep !== undefined && gateVerdict === 'fail';
        if (failed) failedRuns.add(runId);
        sendResult(ctx, { run_id: runId, status: failed ? 'failed' : 'completed',
          completion_reason: failed ? 'step_failed' : 'success', completed_steps: 1 });
      },
      'journal.read': (ctx, params) => {
        const runId = params.run_id as string;
        if (runId === ROOT) {
          const from = (params.from_seq as number) ?? 1;
          sendResult(ctx, { entries: rootEntries.map((entry, index) => ({ seq: index + 1, ...entry })).filter(entry => entry.seq >= from) });
          return;
        }
        const failed = failedRuns.has(runId);
        sendResult(ctx, { entries: [{
          entry_type: 'step.completed', step_id: stepOf.get(runId),
          payload: { completionReason: failed ? 'verification_failed' : 'success', disposition: 'step_done',
            output: failed ? null : { exit_code: 0, stdout_tail: outputs.get(runId) ?? '', stderr_tail: '' } },
        }] });
      },
      'stream.read': (ctx) => sendResult(ctx, { messages: [], next_offset: 0 }),
      // Every authored operation indexes its child run on the root's
      // `authored-steps` stream before awaiting it, so a journal that cannot
      // append is a journal that cannot record evidence.
      'stream.append': (ctx) => sendResult(ctx, { offset: streamAppends++ }),
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });

  beforeEach(() => { rootEntries = []; started.length = 0; failedRuns.clear(); gateVerdict = 'pass'; });

  async function client(): Promise<JournalClient> {
    const journal = new JournalClient(path, { requestTimeoutMs: 2000 });
    await journal.connect();
    await journal.hello('authored-human-test');
    return journal;
  }

  const asked = { entry_type: 'wait.human', step_id: 'authored-root', attempt: 1,
    payload: { wait_id: 'human-1', prompt: 'Ship it?', requested_of: 'khaliq', options: ['yes', 'no'] } };
  const answered = (result: unknown) => ({ entry_type: 'wait.completed', step_id: 'authored-root', attempt: 1,
    payload: { wait_id: 'human-1', completionReason: 'human_responded', result } });

  it('parks the body on an unanswered question without starting a child run', async () => {
    const journal = await client();
    try {
      const handle = flow('ask', async f => {
        const ok = await f.human('Ship it?', { to: 'khaliq' });
        f.done(ok ? 'success' : 'declined');
      });
      const failure = await executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT }).catch(error => error);
      expect(failure).toBeInstanceOf(AuthoredHumanParked);
      expect(failure).toMatchObject({ code: 'human_parked', runId: ROOT,
        wait: { waitId: 'human-1', question: 'Ship it?', to: 'khaliq' } });
      expect(started).toEqual([]);
    } finally { journal.close(); }
  });

  it('still parks while the question is asked but not yet answered', async () => {
    rootEntries = [asked];
    const journal = await client();
    try {
      const handle = flow('ask', async f => { await f.human('Ship it?', { to: 'khaliq' }); f.done('success'); });
      await expect(executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT })).rejects.toBeInstanceOf(AuthoredHumanParked);
      expect(started).toEqual([]);
      expect(await readOpenHumanWaits(journal, ROOT)).toEqual([
        { waitId: 'human-1', question: 'Ship it?', to: 'khaliq', stepId: 'authored-root', attempt: 1 },
      ]);
    } finally { journal.close(); }
  });

  it('continues with the recorded answer, lowered as a memoized human-N step', async () => {
    rootEntries = [asked, answered({ answer: true, note: 'lgtm', answeredBy: 'khaliq', at_ms: Date.UTC(2026, 8, 18), attribution: 'client_asserted' })];
    const journal = await client();
    try {
      const handle = flow('ask', async f => {
        const ok = await f.human('Ship it?', { to: 'khaliq' });
        f.done(ok ? 'success' : 'declined');
      });
      const result = await executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT });
      expect(result.completionReason).toBe('success');
      expect(result.journalSteps.map(step => step.id)).toEqual(['human-1', 'complete-2']);
      expect(started[0]).toMatchObject({ id: 'human-1' });
      expect(started[0]!.admissionKey).toMatch(/^[a-z0-9:_-]+$/i);
      expect(JSON.parse(outputs.get('child-1')!)).toEqual({ human: 'human-1', to: 'khaliq', answer: true, note: 'lgtm', answeredBy: 'khaliq', at: '2026-09-18T00:00:00.000Z' });
      expect(await readOpenHumanWaits(journal, ROOT)).toEqual([]);
    } finally { journal.close(); }
  });

  it('lowers a named gate on the answer into the human-N step, so a rejected answer can fail it', async () => {
    const gate = { type: 'regex_match', pattern: '"answer":true' } as const;
    // Approved: the gate is in the lowered spec, passes, and the body continues.
    rootEntries = [asked, answered({ answer: true, answeredBy: 'khaliq' })];
    let journal = await client();
    try {
      const handle = flow('gated', async f => { await f.human('Ship it?', { to: 'khaliq' }).gate(gate); f.done('success'); });
      const result = await executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT });
      expect(result.completionReason).toBe('success');
      expect(started[0]?.gate?.id).toBe('human-1.gate');
      expect(started[0]?.gate?.command).toContain(JSON.stringify(gate.pattern));
    } finally { journal.close(); }
    // Rejected: the same gate is judged on the journaled answer and fails the step.
    rootEntries = [asked, answered({ answer: false, answeredBy: 'khaliq' })];
    started.length = 0;
    gateVerdict = 'fail';
    journal = await client();
    try {
      const handle = flow('gated', async f => { await f.human('Ship it?', { to: 'khaliq' }).gate(gate); f.done('success'); });
      await expect(executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT })).rejects.toMatchObject({ code: 'step_failed' });
      expect(started[0]?.gate?.id).toBe('human-1.gate');
    } finally { journal.close(); }
  });

  it('a negative answer is a value, not a failure', async () => {
    rootEntries = [asked, answered({ answer: false, answeredBy: 'khaliq' })];
    const journal = await client();
    try {
      const handle = flow('ask', async f => {
        const ok = await f.human('Ship it?', { to: 'khaliq' });
        f.done(ok ? 'success' : 'declined');
      });
      expect((await executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT })).completionReason).toBe('declined');
    } finally { journal.close(); }
  });

  it('asks the second question only after the first is answered, under its own id', async () => {
    rootEntries = [asked, answered({ answer: true, answeredBy: 'khaliq' })];
    const journal = await client();
    try {
      const handle = flow('ask-twice', async f => {
        await f.human('Ship it?', { to: 'khaliq' });
        await f.human('Announce it?', { to: 'marketing' });
        f.done('success');
      });
      const failure = await executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT }).catch(error => error);
      expect(failure).toMatchObject({ wait: { waitId: 'human-2', question: 'Announce it?', to: 'marketing' } });
      expect(started.map(step => step.id)).toEqual(['human-1']);
    } finally { journal.close(); }
  });

  it('refuses a recorded answer that is not { answer: boolean, answeredBy }', async () => {
    for (const bad of [{ answer: 'yes', answeredBy: 'khaliq' }, { answer: true }, { answer: true, answeredBy: ' ' }]) {
      rootEntries = [asked, answered(bad)];
      const journal = await client();
      try {
        const handle = flow('ask', async f => { await f.human('Ship it?', { to: 'khaliq' }); f.done('success'); });
        await expect(executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT })).rejects.toMatchObject({ code: 'human_answer_invalid' });
      } finally { journal.close(); }
    }
  });

  it('refuses an empty question or an unnamed recipient before touching the journal', async () => {
    const journal = new JournalClient('/journal-must-not-be-contacted');
    for (const handle of [
      flow('blank', async f => { await f.human('   ', { to: 'khaliq' }); f.done('success'); }),
      flow('nobody', async f => { await f.human('Ship it?', { to: '' }); f.done('success'); }),
    ]) {
      await expect(executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT })).rejects.toMatchObject({ code: 'human_answer_invalid' });
    }
  });

  it('refuses a malformed `to` as human_to_invalid before consuming an ordinal or touching the journal', async () => {
    const journal = new JournalClient('/journal-must-not-be-contacted');
    for (const to of ['slack:', 'github:#eng', 'email:khaliq', 'slack:@two words', 'slack:#', '@']) {
      const handle = flow('bad-to', async f => { await f.human('Ship it?', { to }); f.done('success'); });
      const failure = await executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT }).catch(error => error);
      expect(failure, to).toMatchObject({ code: 'human_to_invalid' });
      expect(String(failure.message), to).toContain('f.human to');
    }
  });

  it('needs a durable root to park in', async () => {
    const journal = await client();
    try {
      const handle = flow('rootless', async f => { await f.human('Ship it?', { to: 'khaliq' }); f.done('success'); });
      await expect(executeAuthoredFlow(handle, journal)).rejects.toMatchObject({ code: 'unsupported_verb' });
    } finally { journal.close(); }
  });

  it('an unawaited f.human is an unawaited step', async () => {
    rootEntries = [asked, answered({ answer: true, answeredBy: 'khaliq' })];
    const journal = await client();
    try {
      const handle = flow('fire-and-forget', async f => { f.human('Ship it?', { to: 'khaliq' }); f.done('success'); });
      await expect(executeAuthoredFlow(handle, journal, undefined, { rootRunId: ROOT })).rejects.toMatchObject({ code: 'unawaited_step' });
    } finally { journal.close(); }
  });
});

describe('the answer contract', () => {
  it('the client sends { answer, note?, answeredBy }; the kernel adds at_ms and attribution', () => {
    const payload = humanAnswerPayload(true, { note: 'ok', answeredBy: 'khaliq' });
    expect(payload).toEqual({ answer: true, note: 'ok', answeredBy: 'khaliq' });
    expect(humanAnswerPayload(false, { note: '', answeredBy: 'khaliq' })).not.toHaveProperty('note');
    expect(() => humanAnswerPayload(true, { answeredBy: '  ' })).toThrow(/human_answer_invalid/);
    // What the journal hands back: the kernel's clock and its attribution note.
    expect(parseHumanAnswer({ ...payload, at_ms: 1_800_000_000_000, attribution: 'client_asserted' }, 'human-1'))
      .toEqual({ answer: true, note: 'ok', answeredBy: 'khaliq', atMs: 1_800_000_000_000, attribution: 'client_asserted' });
  });
  it('refuses every other shape', () => {
    for (const bad of [null, 'yes', { answer: 'yes', answeredBy: 'k' }, { answer: true, note: 3, answeredBy: 'k' }, {}, { answer: true }, { answer: true, answeredBy: 'k', at_ms: 1.5 }]) {
      expect(() => parseHumanAnswer(bad, 'human-1')).toThrow(/human_answer_invalid/);
    }
  });
});
