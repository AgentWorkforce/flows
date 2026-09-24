// `done(reason, { detail })`: the flow says why, and the reason survives.
//
// Cloud run f92bf832-7848-58d8-b5ca-da8e3b849f1c finished `step_failed` after
// twenty successful steps and an opened PR. The reviewer's finding — "one P2
// remains: cleanup can report success while an ambiguous allocation stays
// invisible through all three sweeps" — existed, and neither the run report
// nor `flows status --cloud` held a word of it. These tests pin the path that
// carries it: normalization at `done()`, the durable marker, the root's
// output, the IPC verifier, and the report.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow, type Ctx } from '@relayflows/surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPLETION_DETAIL_MAX_CODE_POINTS,
  COMPLETION_DETAIL_TRUNCATED_SUFFIX,
  completionMarker,
  isDurableCompletionDetail,
  normalizeCompletionDetail,
  singleLineCompletionDetail,
} from '../src/authored-completion.js';
import { canonicalize } from '../src/canonical.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { authoredCompletion, type RunReport } from '../src/cli/run.js';
import { JournalClient } from '../src/journal-client.js';
import {
  kernelDialectError,
  sendOk,
  sendResult,
  sockPath,
  startLoopback,
} from './journal-client-loopback.js';

/** The reviewer's sentence from cloud#3919, which the run record threw away. */
const FINDING = 'One P2 remains: cleanup can report success while an ambiguous '
  + 'allocation stays invisible through all three sweeps — `review.clean` was not created.';

const LOWERED = ['success', 'needs_human', 'step_failed', 'declined'] as const;

/**
 * The complete lowered spec and its canonical hash for every no-detail
 * completion, captured from the tree BEFORE this change (commit 16237b6) with
 * the same loopback this file uses.
 *
 * Marker-string equality alone would not catch a lowering that changed around
 * the marker, so the whole spec is hashed. A flow that passes no detail must
 * produce these bytes exactly, or a released flow's `spec_hash` moved and its
 * memoized children stopped matching.
 */
const PRE_CHANGE_SPEC: Record<typeof LOWERED[number], { json: string; sha256: string }> = {
  success: {
    sha256: '2bca7a2d3291b698623671e3527c0fbfa9fca0ad0a032996749d663b27f7549a',
    json: '{"name":"stability-success/complete-1","steps":[{"command":":","depends_on":[],"id":"complete-1","max_iterations":1,"retry":{"initial_backoff_ms":100,"jitter_percent":20,"max_backoff_ms":60000,"multiplier":2},"type":"deterministic","verification":{}}],"version":"0.1.0"}',
  },
  needs_human: {
    sha256: 'd8504f8cc11ff05d8a389f9c177a06d905e9083c8fa006783c866ef2ec892b61',
    json: '{"name":"stability-needs_human/complete-1","steps":[{"command":"printf \'%s\' \'{\\"completionReason\\":\\"needs_human\\"}\'","depends_on":[],"id":"complete-1","max_iterations":1,"retry":{"initial_backoff_ms":100,"jitter_percent":20,"max_backoff_ms":60000,"multiplier":2},"type":"deterministic","verification":{}}],"version":"0.1.0"}',
  },
  step_failed: {
    sha256: 'e749f41b3b319b10ab77e2ee57a5be4b8eecd8bbd5fe20d5c73eb980d111ed70',
    json: '{"name":"stability-step_failed/complete-1","steps":[{"command":"printf \'%s\' \'{\\"completionReason\\":\\"step_failed\\"}\'","depends_on":[],"id":"complete-1","max_iterations":1,"retry":{"initial_backoff_ms":100,"jitter_percent":20,"max_backoff_ms":60000,"multiplier":2},"type":"deterministic","verification":{}}],"version":"0.1.0"}',
  },
  declined: {
    sha256: 'f62919dc650b5ffcaa79f0b763b732a2fe5ebd9e36e924f26753d0077111242f',
    json: '{"name":"stability-declined/complete-1","steps":[{"command":"printf \'%s\' \'{\\"completionReason\\":\\"declined\\"}\'","depends_on":[],"id":"complete-1","max_iterations":1,"retry":{"initial_backoff_ms":100,"jitter_percent":20,"max_backoff_ms":60000,"multiplier":2},"type":"deterministic","verification":{}}],"version":"0.1.0"}',
  },
};

describe('normalizing done()\'s optional detail', () => {
  it.each([
    ['no options at all', undefined],
    ['empty options', {}],
    ['an explicitly undefined detail', { detail: undefined }],
    ['an empty detail', { detail: '' }],
    ['a whitespace-only detail', { detail: '  \n\t ' }],
  ])('reads %s as no detail', (_label, options) => {
    expect(normalizeCompletionDetail(options, {})).toBeUndefined();
  });

  it.each([
    ['null', null, 'options must be an object'],
    ['an array', ['why'], 'options must be an object'],
    ['a bare string', 'why', 'options must be an object'],
    ['a number', 7, 'options must be an object'],
    ['a non-string detail', { detail: 7 }, 'detail must be a string'],
    ['a null detail', { detail: null }, 'detail must be a string'],
    ['an array detail', { detail: ['why'] }, 'detail must be a string'],
  ])('refuses %s with unsupported_completion', (_label, options, fragment) => {
    expect(() => normalizeCompletionDetail(options, {}))
      .toThrowError(expect.objectContaining({ code: 'unsupported_completion' }));
    expect(() => normalizeCompletionDetail(options, {})).toThrowError(fragment);
  });

  it('names the type it got, never the value — a malformed detail may be a credential', () => {
    let message = '';
    try { normalizeCompletionDetail({ detail: { token: 'rk_live_NEVERPRINTTHIS' } }, {}); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('detail must be a string; received a object');
    expect(message).not.toContain('NEVERPRINTTHIS');
    expect(message).not.toContain('rk_live');
  });

  it('keeps prose, trimming only the surrounding whitespace', () => {
    expect(normalizeCompletionDetail({ detail: `\n${FINDING}\n` }, {})).toBe(FINDING);
  });

  it('redacts a known token shape and a secret environment value', () => {
    const env = { RELAY_API_KEY: 'super-secret-workspace-material' };
    const detail = `link ot_live_abc123DEF456 and key ${env.RELAY_API_KEY}`;
    const normalized = normalizeCompletionDetail({ detail }, env)!;
    expect(normalized).not.toContain('ot_live_abc123DEF456');
    expect(normalized).not.toContain('super-secret-workspace-material');
    expect(normalized).toBe('link [redacted] and key [redacted:RELAY_API_KEY]');
  });

  it.each([
    [COMPLETION_DETAIL_MAX_CODE_POINTS - 1, false],
    [COMPLETION_DETAIL_MAX_CODE_POINTS, false],
    [COMPLETION_DETAIL_MAX_CODE_POINTS + 1, true],
  ])('bounds a %i-code-point detail (truncated: %s)', (length, truncated) => {
    const normalized = normalizeCompletionDetail({ detail: 'a'.repeat(length) }, {})!;
    expect([...normalized]).toHaveLength(Math.min(length, COMPLETION_DETAIL_MAX_CODE_POINTS));
    expect(normalized.endsWith(COMPLETION_DETAIL_TRUNCATED_SUFFIX)).toBe(truncated);
  });

  it('counts code points, not UTF-16 units, so an emoji detail is not halved', () => {
    // 3,000 astral code points is 6,000 UTF-16 units. A `.length` bound would
    // cut this at 1,000 emoji; the documented bound cuts at the suffix.
    const normalized = normalizeCompletionDetail({ detail: '🙂'.repeat(3000) }, {})!;
    const points = [...normalized];
    expect(points).toHaveLength(COMPLETION_DETAIL_MAX_CODE_POINTS);
    expect(normalized.endsWith(COMPLETION_DETAIL_TRUNCATED_SUFFIX)).toBe(true);
    expect(points.filter((point) => point === '🙂'))
      .toHaveLength(COMPLETION_DETAIL_MAX_CODE_POINTS - [...COMPLETION_DETAIL_TRUNCATED_SUFFIX].length);
  });

  it('redacts BEFORE it truncates, so the cut cannot create a leak', () => {
    // A secret environment value is redacted by exact match (`replaceAll`).
    // Cut it in half first and there is nothing left for that match to find,
    // so the truncation is what journals a fragment of live material.
    const secret = 'S'.repeat(40);
    const env = { RELAY_API_KEY: secret };
    const prefix = `${'x'.repeat(1959)} `;
    const raw = `${prefix}${secret} tail`;
    const keep = COMPLETION_DETAIL_MAX_CODE_POINTS - [...COMPLETION_DETAIL_TRUNCATED_SUFFIX].length;
    expect([...raw].length).toBeGreaterThan(COMPLETION_DETAIL_MAX_CODE_POINTS);
    expect(raw.indexOf(secret)).toBeLessThan(keep);
    expect(raw.indexOf(secret) + secret.length).toBeGreaterThan(keep);

    const normalized = normalizeCompletionDetail({ detail: raw }, env)!;
    expect(normalized).not.toContain(secret);
    expect(normalized).not.toContain('S'.repeat(8));
    // Redacting first also shrank it back under the bound, so nothing was cut.
    expect(normalized).toBe(`${prefix}[redacted:RELAY_API_KEY] tail`);
    expect(normalized.endsWith(COMPLETION_DETAIL_TRUNCATED_SUFFIX)).toBe(false);
  });

  it.each([
    ['a high surrogate left by slicing an emoji off the end', `${FINDING} \u{1F642}`.slice(0, -1), `${FINDING} \uFFFD`],
    ['a low surrogate left by slicing one off the front', '\u{1F642} tail'.slice(1), '\uFFFD tail'],
    ['a lone surrogate in the middle of prose', 'P2 \uD800 remains', 'P2 \uFFFD remains'],
  ])('substitutes %s', (_label, raw, expected) => {
    // `('review found 1 P2: ' + '\u{1F642}').slice(0, -1)` is ordinary JS string
    // trimming of reviewer output, and it produces a `string` that is not
    // text. `JSON.stringify` escapes it, so the marker COMMAND is admitted —
    // and then the raw detail in the root's `step.complete` output is refused
    // by the kernel's JSON decoder with a null-id `bad_request` that resolves
    // no pending request, so the call never returns and the explanation is lost.
    expect(normalizeCompletionDetail({ detail: raw }, {})).toBe(expected);
  });

  it('leaves well-formed text alone, surrogate pairs included', () => {
    for (const detail of [FINDING, '\u{1F642} kept whole', '検査は \u{1F642} で終わった']) {
      expect(normalizeCompletionDetail({ detail }, {})).toBe(detail);
    }
  });

  it('gates a durable value on the same bound it wrote', () => {
    expect(isDurableCompletionDetail(FINDING)).toBe(true);
    expect(isDurableCompletionDetail('a'.repeat(COMPLETION_DETAIL_MAX_CODE_POINTS))).toBe(true);
    expect(isDurableCompletionDetail('a'.repeat(COMPLETION_DETAIL_MAX_CODE_POINTS + 1))).toBe(false);
    expect(isDurableCompletionDetail('🙂'.repeat(COMPLETION_DETAIL_MAX_CODE_POINTS))).toBe(true);
    expect(isDurableCompletionDetail('🙂'.repeat(COMPLETION_DETAIL_MAX_CODE_POINTS + 1))).toBe(false);
    expect(isDurableCompletionDetail('')).toBe(false);
    expect(isDurableCompletionDetail(7)).toBe(false);
    expect(isDurableCompletionDetail(undefined)).toBe(false);
  });

  it('refuses a durable value the journal protocol cannot carry', () => {
    // The same invariant normalization enforces, enforced again at every read
    // boundary: a lone surrogate is a string the kernel's JSON decoder
    // rejects, so it is not a value a durable record may claim to hold.
    expect(isDurableCompletionDetail(`${FINDING} \u{1F642}`.slice(0, -1))).toBe(false);
    expect(isDurableCompletionDetail('\uDC00 orphan low')).toBe(false);
    expect(isDurableCompletionDetail(`${FINDING} \u{1F642}`)).toBe(true);
    expect(isDurableCompletionDetail(normalizeCompletionDetail(
      { detail: `${FINDING} \u{1F642}`.slice(0, -1) }, {}))).toBe(true);
  });

  it('folds a multiline detail onto one line without losing a character of it', () => {
    const multiline = 'P1 none\nP2 one: review.clean missing\r\nP3 none\ttabbed\u0007bell';
    expect(singleLineCompletionDetail(multiline))
      .toBe('P1 none\\nP2 one: review.clean missing\\r\\nP3 none\\ttabbed\\u0007bell');
    expect(singleLineCompletionDetail(FINDING)).toBe(FINDING);
  });
});

describe('the terminal marker that carries the detail', () => {
  it.each(LOWERED)('leaves done("%s") with no detail byte-identical', (reason) => {
    expect(completionMarker(reason)).toBe(reason === 'success'
      ? ':' : `printf '%s' '{"completionReason":"${reason}"}'`);
    expect(completionMarker(reason, undefined)).toBe(completionMarker(reason));
  });

  it.each([
    ['plain prose', FINDING],
    ['single quotes', `it's the reviewer's 'clean' file`],
    ['double quotes and backslashes', 'said "no" at C:\\work\\review.md'],
    ['newlines and tabs', 'P1: none\nP2: one\r\n\tindented'],
    ['command substitution', 'ran $(id) and `whoami` and ${HOME}'],
    ['a shell terminator', "'; rm -rf /tmp/nothing; echo '"],
    ['unicode', '検査は 🙂 で終わった — naïve'],
  ])('executes as a shell command whose stdout is the verdict (%s)', (_label, detail) => {
    const command = completionMarker('step_failed', detail);
    const stdout = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    expect(JSON.parse(stdout)).toEqual({ completionReason: 'step_failed', detail });
    // One line, so the journaled command stays greppable.
    expect(command).not.toContain('\n');
  });

  it('carries a normalized sliced-emoji detail through the shell unchanged', () => {
    const detail = normalizeCompletionDetail({ detail: `${FINDING} \u{1F642}`.slice(0, -1) }, {})!;
    const stdout = execFileSync('/bin/sh', ['-c', completionMarker('step_failed', detail)], { encoding: 'utf8' });
    expect(JSON.parse(stdout)).toEqual({ completionReason: 'step_failed', detail });
    expect(detail).toBe(`${FINDING} \uFFFD`);
  });
});

describe('an executed flow that declares why', () => {
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
        const runId = `detail-run-${nextRun++}`;
        startedSpecs.push(spec);
        stepByRun.set(runId, { id: step['id'] as string, command: step['command'] as string });
        sendResult(ctx, {
          run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1,
        });
      },
      'journal.read': (ctx, params) => {
        const step = stepByRun.get(params.run_id as string)!;
        sendResult(ctx, {
          entries: [{
            entry_type: 'step.completed',
            step_id: step.id,
            payload: { completionReason: 'success', output: { exit_code: 0, stdout_tail: '', stderr_tail: '' } },
          }],
        });
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });

  async function execute(name: string, body: (f: Ctx) => Promise<void>) {
    startedSpecs.length = 0;
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello(name);
    try {
      return await executeAuthoredFlow(flow(name, body), client);
    } finally {
      client.close();
    }
  }

  it('journals the detail inside the marker and returns it on the result', async () => {
    const result = await execute('software-factory', async (f) => {
      await f.run('printf ok');
      f.done('step_failed', { detail: FINDING });
    });

    expect(result.completionReason).toBe('step_failed');
    expect(result.completionDetail).toBe(FINDING);
    // Every step, marker included, still SUCCEEDED: the verdict is data the
    // body declared, not a step that failed.
    expect(result.journalSteps.map((step) => step.completionReason)).toEqual(['success', 'success']);
    const marker = (startedSpecs.at(-1) as { steps: Array<{ command: string }> }).steps[0]!.command;
    expect(JSON.parse(execFileSync('/bin/sh', ['-c', marker], { encoding: 'utf8' })))
      .toEqual({ completionReason: 'step_failed', detail: FINDING });
  });

  it.each(LOWERED)('lowers a detail on done("%s") too', async (reason) => {
    const result = await execute(`detailed-${reason}`, async (f) => {
      f.done(reason, { detail: `why ${reason}` });
    });
    expect(result.completionReason).toBe(reason);
    expect(result.completionDetail).toBe(`why ${reason}`);
    const marker = (startedSpecs[0] as { steps: Array<{ command: string }> }).steps[0]!.command;
    expect(JSON.parse(execFileSync('/bin/sh', ['-c', marker], { encoding: 'utf8' })))
      .toEqual({ completionReason: reason, detail: `why ${reason}` });
  });

  it.each(LOWERED)('leaves the whole lowered spec of a no-detail done("%s") unchanged', async (reason) => {
    const fixture = PRE_CHANGE_SPEC[reason];
    for (const options of [undefined, {}, { detail: undefined }, { detail: '   ' }] as const) {
      startedSpecs.length = 0;
      const client = new JournalClient(path, { requestTimeoutMs: 2000 });
      await client.connect();
      await client.hello(`stability-${reason}`);
      try {
        await executeAuthoredFlow(flow(`stability-${reason}`, async (f) => {
          if (options === undefined) f.done(reason); else f.done(reason, options);
        }), client);
      } finally {
        client.close();
      }
      const json = canonicalize(startedSpecs[0]);
      expect(json).toBe(fixture.json);
      expect(createHash('sha256').update(json).digest('hex')).toBe(fixture.sha256);
    }
  });

  it('carries the normalized detail, not the author\'s raw string', async () => {
    const result = await execute('redacted-at-done', async (f) => {
      f.done('step_failed', { detail: `  leaked ot_live_abc123DEF456 in review  ` });
    });
    expect(result.completionDetail).toBe('leaked [redacted] in review');
    expect(canonicalize(startedSpecs[0])).not.toContain('ot_live_');
  });

  it.each([
    ['non-object options', 'why'],
    ['a non-string detail', { detail: 7 }],
  ])('refuses %s and does not complete the flow', async (_label, options) => {
    await expect(execute(`refused-${_label.replaceAll(' ', '-')}`, async (f) => {
      (f.done as (reason: 'step_failed', options: unknown) => void)('step_failed', options);
    })).rejects.toMatchObject({ code: 'unsupported_completion' });
    // Refused before `markCompletion`, so no marker was journaled.
    expect(startedSpecs).toHaveLength(0);
  });

  it('keeps the kernel-owned refusals ahead of any options check', async () => {
    await expect(execute('kernel-owned-with-detail', async (f) => {
      (f.done as (reason: 'canceled', options: unknown) => void)('canceled', { detail: 7 });
    })).rejects.toMatchObject({ code: 'unsupported_completion', completionReason: 'canceled' });
  });

  it('keeps duplicate completion and post-completion operations unchanged', async () => {
    await expect(execute('duplicate-with-detail', async (f) => {
      f.done('step_failed', { detail: 'first' });
      f.done('success', { detail: 'second' });
    })).rejects.toMatchObject({ code: 'duplicate_completion' });

    await expect(execute('after-completion-with-detail', async (f) => {
      f.done('step_failed', { detail: 'done already' });
      await f.run('printf late');
    })).rejects.toMatchObject({ code: 'operation_after_completion' });
  });
});

describe('the report a detail-bearing completion produces', () => {
  const base: RunReport = { ok: false, command: 'run', resolutions: [], diagnostics: [] };
  const result = (
    completionReason: 'success' | 'needs_human' | 'step_failed' | 'declined',
    completionDetail?: string,
  ) => ({
    name: 'software-factory',
    completionReason,
    ...(completionDetail === undefined ? {} : { completionDetail }),
    journalSteps: [{}, {}],
  });

  it('replaces the generic step_failed sentence with what the flow said', () => {
    const execution = authoredCompletion('run', base, '/sock', result('step_failed', FINDING), 'root');

    expect(execution.exitCode).toBe(1);
    expect(execution.report.status).toBe('failed');
    expect(execution.report.completionReason).toBe('step_failed');
    expect(execution.report.completionDetail).toBe(FINDING);
    const diagnostic = execution.report.diagnostics.at(-1)!;
    expect(diagnostic.kind).toBe('step_failed');
    expect(diagnostic.message).toBe(`Flow "software-factory" declared done("step_failed"): ${FINDING}`);
    expect(diagnostic.message).not.toContain('no step-level evidence to inspect');
    expect((diagnostic as { detail?: string }).detail).toBe(FINDING);
  });

  it('keeps the no-detail step_failed message byte-identical', () => {
    const execution = authoredCompletion('resume', base, '/sock', result('step_failed'), 'root');
    expect(execution.report.diagnostics.at(-1)!.message).toBe(
      'Flow "software-factory" declared done("step_failed"): its own checks did not pass. '
      + 'No step failed, so there is no step-level evidence to inspect; the journal holds '
      + 'every step the flow ran before it decided.',
    );
    expect(execution.report.completionDetail).toBeUndefined();
    expect('completionDetail' in execution.report).toBe(false);
    expect((execution.report.diagnostics.at(-1) as { detail?: string }).detail).toBeUndefined();
  });

  it('names no step, because no step failed', () => {
    const execution = authoredCompletion('run', base, '/sock', result('step_failed', FINDING), 'root');
    const diagnostic = execution.report.diagnostics.at(-1) as { stepId?: string; exitCode?: number };
    expect(diagnostic.stepId).toBeUndefined();
    expect(diagnostic.exitCode).toBeUndefined();
  });

  it('folds a multiline detail onto the message line and keeps the original beside it', () => {
    const multiline = 'P1: none\nP2: review.clean was not created\nP3: none';
    const execution = authoredCompletion('run', base, '/sock', result('step_failed', multiline), 'root');
    const diagnostic = execution.report.diagnostics.at(-1)!;
    expect(diagnostic.message).toContain('P1: none\\nP2: review.clean was not created\\nP3: none');
    expect(diagnostic.message).not.toContain('\n');
    expect((diagnostic as { detail?: string }).detail).toBe(multiline);
    expect(execution.report.completionDetail).toBe(multiline);
  });

  it('adds the detail to needs_human and declined without moving their exit codes', () => {
    const parked = authoredCompletion('run', base, '/sock', result('needs_human', 'blocked on the allocation'), 'root');
    expect(parked.exitCode).toBe(3);
    expect(parked.report.status).toBe('parked');
    expect(parked.report.diagnostics.at(-1)!.kind).toBe('run_parked');
    expect(parked.report.diagnostics.at(-1)!.message).toBe(
      'Flow "software-factory" needs_human; see the journal for accumulated blockers. blocked on the allocation');

    const declined = authoredCompletion('run', base, '/sock', result('declined', 'no ticket in the input'), 'root');
    expect(declined.exitCode).toBe(0);
    expect(declined.report.ok).toBe(true);
    expect(declined.report.status).toBe('completed');
    expect(declined.report.completionReason).toBe('success');
    expect(declined.report.diagnostics.at(-1)!.kind).toBe('run_declined');
    expect(declined.report.diagnostics.at(-1)!.message).toBe(
      'Flow deliberately chose not to act on this input. no ticket in the input');
  });

  it('reports a successful flow\'s detail without inventing a diagnostic', () => {
    const execution = authoredCompletion('run', base, '/sock', result('success', 'all three sweeps clean'), 'root');
    expect(execution.exitCode).toBe(0);
    expect(execution.report.ok).toBe(true);
    expect(execution.report.completionDetail).toBe('all three sweeps clean');
    expect(execution.report.diagnostics).toEqual([]);
  });
});
