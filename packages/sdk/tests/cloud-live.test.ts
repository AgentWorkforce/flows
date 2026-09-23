// `flows status --cloud --watch` and `flows logs <run> --follow` against a
// fake Cloud that changes its mind between polls.
//
// The fixtures keep `cloud-read.test.ts`'s vocabulary — the camelCase field
// names the real routes emit — and add the shapes only a live run has: a step
// row with a `startTime` and no `endTime`, a log envelope that is not `done`,
// and a run record that answers `running` for the first polls and `completed`
// after. Every test injects the clock and the sleep, so nothing here waits.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { runCloudLogsFollow, runCloudStatusWatch } from '../src/cli/cloud-live.js';
import { runCloudStatusCli, parseLogsArgs } from '../src/cli/cloud-read.js';
import { parseStatusArgs } from '../src/cli/status.js';

const RUN = '20d04c99-3fa8-48c9-9286-92d364a5bc2e';
const CONNECTION = { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token', env: {} };
const STARTED = '2026-09-19T20:34:58.286Z';
/** `startTime` of the live `agent-5` row; `NOW` is 6m50s after it. */
const STEP_STARTED = '2026-09-19T20:35:10.000Z';
const NOW = Date.parse(STEP_STARTED) + 410_000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface Answer { status?: number; body: unknown }
/** One poll's worth of answers: the run record, its step rows, its runner log. */
interface Stage { run: Answer; steps?: Answer; log?: Answer }

function io(tty = false) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  // A watched frame arrives as one `stdout` call, so `stdout[n]` is the nth
  // frame and not the nth line; tests that care about lines split it.
  return {
    stdout, stderr,
    io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line), tty },
  };
}

/**
 * A fake Cloud that advances one stage per run-record read.
 *
 * The run record is the first request of every tick, so consuming a stage
 * there makes "the third poll" expressible; the steps and logs routes answer
 * from the stage the current tick is on. The last stage repeats, so a test
 * only writes the transitions it cares about.
 */
function stagedCloud(stages: readonly Stage[], onRequest?: (path: string, index: number) => void) {
  const requests: { path: string; query: string }[] = [];
  let index = -1;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, query: url.search });
    if (url.pathname.endsWith('/steps')) onRequest?.('steps', Math.max(index, 0));
    else if (url.pathname.endsWith('/logs')) onRequest?.('logs', Math.max(index, 0));
    else {
      index = Math.min(index + 1, stages.length - 1);
      onRequest?.('run', index);
    }
    const stage = stages[Math.max(index, 0)]!;
    const answer = url.pathname.endsWith('/steps') ? stage.steps ?? { body: { steps: [] } }
      : url.pathname.endsWith('/logs') ? stage.log ?? { body: { content: '', offset: 0, totalSize: 0, done: false } }
        : stage.run;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200, headers: { 'content-type': 'application/json' },
    });
  });
  return { requests };
}

function runRecord(overrides: Record<string, unknown> = {}): Answer {
  return {
    body: {
      runId: RUN, relayflowVersion: 'v2', fileType: 'ts', status: 'running',
      workflow: '{"name":"insight-proof-2022"}', createdAt: STARTED, updatedAt: STARTED,
      ...overrides,
    },
  };
}

const RUNNING = runRecord();
const COMPLETED = runRecord({
  status: 'completed',
  result: { ok: true, command: 'run', completedSteps: 3, status: 'completed', completionReason: 'success' },
});
const FAILED = runRecord({
  status: 'failed', error: 'Relayflow v2 CLI failed with exit code 1',
  result: { ok: false, command: 'run', status: 'failed', completionReason: 'step_failed' },
});
const CANCELLED = runRecord({
  status: 'cancelled', result: { ok: false, command: 'run', status: 'cancelled', completionReason: 'canceled' },
});

function stepRow(overrides: Record<string, unknown> = {}) {
  return {
    stepName: 'agent-5', stepType: 'agent', status: 'running', sandboxId: '',
    startTime: STEP_STARTED, endTime: null, retryCount: 0,
    detail: { attempts: [] },
    ...overrides,
  };
}

function stepsBody(rows: readonly unknown[]): Answer {
  return { body: { steps: rows } };
}

function logBody(content: string, overrides: { done?: boolean; totalSize?: number; offset?: number } = {}): Answer {
  const bytes = Buffer.byteLength(content, 'utf8');
  return {
    body: {
      content,
      offset: overrides.offset ?? bytes,
      totalSize: overrides.totalSize ?? bytes,
      done: overrides.done ?? false,
    },
  };
}

/** Injected sleep: records what would have been waited, waits for nothing. */
function recorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number): Promise<void> => { delays.push(ms); } };
}

function live(extra: Record<string, unknown> = {}) {
  return { ...CONNECTION, pollIntervalMs: 2_000, now: () => NOW, sleep: recorder().sleep, ...extra };
}

describe('live step rows', () => {
  it('advances an in-flight row that carries a finished attempt’s wallclock', async () => {
    // A retried step keeps the previous attempt's `wallclockMs` in its detail.
    // Printing that as the running row's elapsed time would freeze the cell at
    // the attempt that already ended while the new one burns.
    stagedCloud([{
      run: RUNNING,
      steps: stepsBody([stepRow({
        status: 'backoff', retryCount: 1,
        detail: { attempts: [{ attempt: 1, disposition: 'step_failed' }], wallclockMs: 3 },
      })]),
    }]);
    const out = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, out.io, { ...CONNECTION, now: () => NOW })).toBe(0);
    expect(out.stdout.join('\n')).toContain('↻ agent-5  agent          backoff      attempt 2  6m50s');
  });

  it('renders running, backoff, waiting and needs_human beside a finished step', async () => {
    stagedCloud([{
      run: RUNNING,
      steps: stepsBody([
        stepRow({
          stepName: 'run-1', stepType: 'deterministic', status: 'completed', completionReason: 'success',
          endTime: '2026-09-19T20:35:09.000Z', durationMs: 3,
          detail: { attempts: [{ attempt: 1, disposition: 'step_done' }], wallclockMs: 3 },
        }),
        stepRow(),
        stepRow({ stepName: 'agent-6', status: 'backoff', retryCount: 1 }),
        stepRow({ stepName: 'human-7', stepType: 'deterministic', status: 'waiting' }),
        stepRow({ stepName: 'human-8', stepType: 'deterministic', status: 'needs_human' }),
      ]),
    }]);
    const out = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, out.io, { ...CONNECTION, now: () => NOW })).toBe(0);
    const rendered = out.stdout.join('\n');
    expect(out.stdout[1]).toBe('steps 5: 1 completed · 1 running · 1 backoff · 1 waiting · 1 needs_human');
    expect(rendered).toContain('↻ agent-5  agent          running      attempt 1  6m50s');
    expect(rendered).toContain('↻ agent-6  agent          backoff      attempt 2  6m50s');
    expect(rendered).toContain('⏸ human-7  deterministic  waiting      attempt 1  6m50s');
    expect(rendered).toContain('⏸ human-8  deterministic  needs_human  attempt 1  6m50s');
    expect(rendered).toContain('✓ run-1    deterministic  completed    1 attempt  0.0s  success');
    // Cloud's step rows carry no maximum-attempt budget, so none is printed.
    expect(rendered).not.toContain('attempt 1/');
  });

  it('counts the attempt now running, not the completed attempt records', async () => {
    // The array holds completion records: during a second attempt it still
    // has one entry, and `attempts.length` would print `attempt 1`.
    stagedCloud([{
      run: RUNNING,
      steps: stepsBody([stepRow({
        retryCount: 1,
        detail: { attempts: [{ attempt: 1, disposition: 'retry', completionReason: 'step_failed' }] },
      })]),
    }]);
    const out = io();
    await runCloudStatusCli({ runId: RUN, json: false }, out.io, { ...CONNECTION, now: () => NOW });
    expect(out.stdout.join('\n')).toContain('running      attempt 2');
  });

  it('omits the attempt and the elapsed time a snapshot does not establish', async () => {
    stagedCloud([{
      run: RUNNING,
      steps: stepsBody([
        // Queued: no dispatch evidence at all, so no attempt is claimed.
        stepRow({ stepName: 'pending-1', status: 'pending', startTime: null, retryCount: null }),
        // Waiting, but the row carries no retry count: the number is unknown.
        stepRow({ stepName: 'wait-2', status: 'waiting', retryCount: null }),
        // A start Cloud wrote in a shape this client cannot parse.
        stepRow({ stepName: 'odd-3', startTime: 'yesterday' }),
        // Clock skew: a start in the future is zero elapsed, never negative.
        stepRow({ stepName: 'skew-4', startTime: new Date(NOW + 60_000).toISOString() }),
      ]),
    }]);
    const out = io();
    await runCloudStatusCli({ runId: RUN, json: false }, out.io, { ...CONNECTION, now: () => NOW });
    const rendered = out.stdout.join('\n');
    expect(rendered).toContain('○ pending-1  agent          pending');
    expect(rendered).not.toMatch(/pending-1.*attempt/u);
    expect(rendered).toContain('⏸ wait-2     agent          waiting');
    expect(rendered).not.toMatch(/wait-2.*attempt/u);
    expect(rendered).toContain('↻ odd-3      agent          running      attempt 1\n');
    expect(rendered).toContain('↻ skew-4     agent          running      attempt 1  0.0s');
  });

  it('does not advance a finished step whose end timestamp is missing', async () => {
    stagedCloud([{
      run: COMPLETED,
      steps: stepsBody([stepRow({
        status: 'completed', completionReason: 'success', endTime: null, durationMs: 9252,
        detail: { attempts: [{ attempt: 1 }], wallclockMs: 9252 },
      })]),
    }]);
    const out = io();
    await runCloudStatusCli({ runId: RUN, json: false }, out.io, { ...CONNECTION, now: () => NOW });
    expect(out.stdout.join('\n')).toContain('completed    1 attempt  9.3s');
    expect(out.stdout.join('\n')).not.toContain('6m50s');
  });

  it('says a running run has no snapshot rather than that it has no steps', async () => {
    stagedCloud([{ run: RUNNING, steps: stepsBody([]) }]);
    const running = io();
    await runCloudStatusCli({ runId: RUN, json: false }, running.io, { ...CONNECTION, now: () => NOW });
    expect(running.stdout[1]).toBe('steps 0');
    expect(running.stdout[2]).toBe('No step snapshot available yet.');

    stagedCloud([{ run: COMPLETED, steps: stepsBody([]) }]);
    const finished = io();
    await runCloudStatusCli({ runId: RUN, json: false }, finished.io, { ...CONNECTION, now: () => NOW });
    expect(finished.stdout.join('\n')).not.toContain('No step snapshot available yet.');
  });
});

describe('flows status --cloud --watch', () => {
  it('redraws each poll, prints the terminal page once and exits with the run', async () => {
    const server = stagedCloud([
      { run: RUNNING, steps: stepsBody([stepRow()]) },
      { run: RUNNING, steps: stepsBody([stepRow()]) },
      {
        run: COMPLETED,
        steps: stepsBody([stepRow({
          status: 'completed', completionReason: 'success', endTime: '2026-09-19T20:42:00.000Z', durationMs: 410_000,
          detail: { attempts: [{ attempt: 1 }], wallclockMs: 410_000 },
        })]),
      },
    ]);
    const out = io();
    const clock = recorder();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io,
      live({ sleep: clock.sleep }))).toBe(0);

    // One frame per poll, each a single write; the last is the terminal page.
    expect(out.stdout).toHaveLength(3);
    expect(out.stdout[0]).toContain('running');
    expect(out.stdout[2]).toContain('completed');
    expect(out.stdout[2]).toContain('finished success');
    expect(out.stdout.filter((frame) => frame.includes('finished success'))).toHaveLength(1);
    // Detail then steps, per tick, and nothing after the terminal page.
    expect(server.requests.map((request) => request.path)).toEqual([
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/steps`,
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/steps`,
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/steps`,
    ]);
    expect(clock.delays).toEqual([2_000, 2_000]);
    expect(out.stderr).toEqual([]);
  });

  it('advances a running step’s elapsed time between frames', async () => {
    stagedCloud([{ run: RUNNING, steps: stepsBody([stepRow()]) }, { run: COMPLETED, steps: stepsBody([stepRow()]) }]);
    let tick = 0;
    const out = io();
    await runCloudStatusWatch({ runId: RUN, json: false }, out.io,
      live({ now: () => NOW + (tick++) * 60_000 }));
    expect(out.stdout[0]).toContain('6m50s');
    expect(out.stdout[1]).toContain('7m50s');
  });

  it('draws one page on a run that is already terminal, and polls once', async () => {
    const server = stagedCloud([{ run: COMPLETED, steps: stepsBody([]) }]);
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io, live())).toBe(0);
    expect(out.stdout).toHaveLength(1);
    expect(server.requests).toHaveLength(2);
  });

  it('exits 1 on a failed run and on a cancelled one, with the failure on the page', async () => {
    stagedCloud([{ run: FAILED, steps: stepsBody([]) }]);
    const failed = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, failed.io, live())).toBe(1);
    expect(failed.stdout[0]).toContain('failed');
    expect(failed.stdout[0]).toContain('Relayflow v2 CLI failed with exit code 1');

    stagedCloud([{ run: CANCELLED, steps: stepsBody([]) }]);
    const cancelled = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, cancelled.io, live())).toBe(1);
    expect(cancelled.stdout[0]).toContain('cancelled');
  });

  it('keeps watching a run whose step is waiting on a human', async () => {
    // `needs_human` is a step state, not a run status: the run is still going.
    const server = stagedCloud([
      { run: RUNNING, steps: stepsBody([stepRow({ status: 'needs_human' })]) },
      { run: COMPLETED, steps: stepsBody([stepRow({ status: 'completed', completionReason: 'success', durationMs: 1 })]) },
    ]);
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io, live())).toBe(0);
    expect(out.stdout).toHaveLength(2);
    expect(server.requests).toHaveLength(4);
  });

  it('clears the screen for a terminal and appends whole pages when redirected', async () => {
    stagedCloud([{ run: RUNNING, steps: stepsBody([]) }, { run: COMPLETED, steps: stepsBody([]) }]);
    const terminal = io(true);
    await runCloudStatusWatch({ runId: RUN, json: false }, terminal.io, live());
    expect(terminal.stdout[0]!.startsWith('\u001b[2J\u001b[H')).toBe(true);

    stagedCloud([{ run: RUNNING, steps: stepsBody([]) }, { run: COMPLETED, steps: stepsBody([]) }]);
    const redirected = io(false);
    await runCloudStatusWatch({ runId: RUN, json: false }, redirected.io, live());
    expect(redirected.stdout.join('')).not.toContain('\u001b');
    expect(redirected.stdout[0]!.startsWith(`RUN ${RUN}`)).toBe(true);
  });

  it('redacts the run name and error in every frame', async () => {
    const env = { CI_TOKEN: 'supersecrettokenvalue' };
    stagedCloud([
      { run: runRecord({ workflow: '{"name":"flow rk_live_NOTAREALSECRET1234"}' }), steps: stepsBody([]) },
      {
        run: runRecord({
          status: 'failed', error: 'died holding supersecrettokenvalue',
          workflow: '{"name":"flow rk_live_NOTAREALSECRET1234"}',
          result: { ok: false, status: 'failed', completionReason: 'step_failed' },
        }),
        steps: stepsBody([]),
      },
    ]);
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io, live({ env }))).toBe(1);
    const rendered = out.stdout.join('\n');
    expect(rendered).not.toContain('rk_live_NOTAREALSECRET1234');
    expect(rendered).not.toContain('supersecrettokenvalue');
    expect(rendered).toContain('[redacted]');
    expect(rendered).toContain('[redacted:CI_TOKEN]');
  });
});

describe('outcome integrity', () => {
  it('refuses a completed record that attests no outcome, rather than exiting 0', async () => {
    for (const body of [
      runRecord({ status: 'completed' }),
      runRecord({ status: 'completed', result: { ok: true, status: 'completed', completionReason: 'step_failed' } }),
      runRecord({ status: 'failed', result: { ok: false, status: 'failed', completionReason: 'success' } }),
    ]) {
      stagedCloud([{ run: body, steps: stepsBody([]) }]);
      const out = io();
      expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io, live())).toBe(1);
      expect(out.stdout).toEqual([]);
      expect(out.stderr[0]).toContain('REFUSED [cloud_invalid_response]');
      expect(out.stderr[0]).toContain('no execution outcome is attested');
    }
  });

  it('refuses a run status this client does not know rather than calling it terminal', async () => {
    stagedCloud([{ run: runRecord({ status: 'cancelling' }), steps: stepsBody([]) }]);
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io, live())).toBe(1);
    expect(out.stderr[0]).toContain('REFUSED [cloud_invalid_response]');
    expect(out.stdout).toEqual([]);
  });

  it('refuses a record for a different run', async () => {
    stagedCloud([{ run: runRecord({ runId: 'some-other-run' }), steps: stepsBody([]) }]);
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io, live())).toBe(1);
    expect(out.stderr[0]).toContain('REFUSED [cloud_invalid_response]');
  });
});

describe('flows logs --follow', () => {
  const HEADER = new RegExp(`^LOG ${RUN}  runner  following`, 'u');

  it('prints each line once as it arrives, then the run’s footer', async () => {
    const first = '[relayflow] ▶ agent-5 (agent) started\n';
    const second = first + '[relayflow] ✓ agent-5 … done in 5m16s · claude-opus-5 · $2.26\n';
    const server = stagedCloud([
      { run: RUNNING, log: logBody(first) },
      { run: RUNNING, log: logBody(second) },
      { run: COMPLETED, log: logBody(second, { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout[0]).toMatch(HEADER);
    expect(out.stdout.slice(1)).toEqual([
      '[relayflow] ▶ agent-5 (agent) started',
      '[relayflow] ✓ agent-5 … done in 5m16s · claude-opus-5 · $2.26',
      `COMPLETED ${RUN} completionReason: success`,
    ]);
    expect(out.stdout.filter((line) => line.startsWith('LOG '))).toHaveLength(1);
    expect(server.requests.map((request) => request.path)).toEqual([
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/logs`,
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/logs`,
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/logs`,
      // The first terminal sighting cannot prove the snapshot postdates the
      // transition; the drained read is always one poll later.
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/logs`,
    ]);
    // The runner log is followed whole; no offset is guessed at.
    expect(server.requests.map((request) => request.query)).toEqual(['', '', '', '', '', '', '', '']);
  });

  it('preserves blank lines and repeats, and prints nothing for a poll that added nothing', async () => {
    const content = 'one\n\none\n';
    stagedCloud([
      { run: RUNNING, log: logBody(content) },
      { run: RUNNING, log: logBody(content) },
      { run: COMPLETED, log: logBody(content, { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout.slice(1, -1)).toEqual(['one', '', 'one']);
  });

  it('holds an incomplete line until its newline arrives, and flushes the last one once', async () => {
    stagedCloud([
      { run: RUNNING, log: logBody('half') },
      { run: RUNNING, log: logBody('half a line\nno newline here') },
      { run: COMPLETED, log: logBody('half a line\nno newline here', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout.slice(1)).toEqual([
      'half a line', 'no newline here', `COMPLETED ${RUN} completionReason: success`,
    ]);
  });

  it('drops the carriage return of a CRLF log rather than overwriting each line', async () => {
    stagedCloud([{ run: COMPLETED, log: logBody('alpha\r\nbeta\r\n', { done: true }) }]);
    const out = io();
    await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live());
    expect(out.stdout.slice(1, -1)).toEqual(['alpha', 'beta']);
  });

  it('says a terminal run’s log is empty rather than printing nothing at all', async () => {
    stagedCloud([{ run: COMPLETED, log: logBody('', { done: true }) }]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout[1]).toBe('  (empty)');
  });

  it('follows a log whose bytes outnumber its characters', async () => {
    // `totalSize` is a byte count and `content` is a string: comparing the two
    // by `content.length` would leave a drained log looking unfinished.
    const content = '▶ résumé 🙂 done\n';
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(content.length);
    stagedCloud([{ run: COMPLETED, log: logBody(content, { done: true }) }]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout[1]).toBe('▶ résumé 🙂 done');
  });

  it('keeps following while the log claims bytes it has not served', async () => {
    const tail = 'first\nsecond\n';
    const server = stagedCloud([
      { run: COMPLETED, log: logBody('first\n', { done: true, totalSize: Buffer.byteLength(tail, 'utf8') }) },
      { run: COMPLETED, log: logBody(tail, { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout.slice(1, -1)).toEqual(['first', 'second']);
    expect(server.requests).toHaveLength(4);
  });

  it('waits for a post-terminal log snapshot before trusting a done upload', async () => {
    // `done: true` on the active poll covered an upload, not the run's last
    // bytes; the first terminal read still serves that stale snapshot, and
    // draining on it would drop the tail published a poll later.
    const server = stagedCloud([
      { run: RUNNING, log: logBody('a\n', { done: true }) },
      { run: COMPLETED, log: logBody('a\n', { done: true }) },
      { run: COMPLETED, log: logBody('a\nb\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout.slice(1, -1)).toEqual(['a', 'b']);
    expect(server.requests).toHaveLength(6);
  });

  it('keeps following a done log while the run is still going, and a live log after it ends', async () => {
    const server = stagedCloud([
      // `done` with an active run: the log upload finished, the run did not.
      { run: RUNNING, log: logBody('a\n', { done: true }) },
      // Terminal with `done: false`: the tail is still being published.
      { run: COMPLETED, log: logBody('a\n', { done: false }) },
      { run: COMPLETED, log: logBody('a\nb\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout.slice(1, -1)).toEqual(['a', 'b']);
    expect(server.requests).toHaveLength(6);
  });

  it('prints a finished failed run’s whole log and exits 1', async () => {
    stagedCloud([{ run: FAILED, log: logBody('boom\n', { done: true }) }]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(1);
    expect(out.stdout.slice(1)).toEqual(['boom', `FAILED ${RUN} completionReason: step_failed`]);
  });

  it('never lets a secret split across two polls reach stdout', async () => {
    const env = { CI_TOKEN: 'supersecrettokenvalue' };
    stagedCloud([
      { run: RUNNING, log: logBody('exported rk_live_NOTARE') },
      { run: RUNNING, log: logBody('exported rk_live_NOTAREALSECRET1234 and supersecret') },
      { run: COMPLETED, log: logBody('exported rk_live_NOTAREALSECRET1234 and supersecrettokenvalue\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live({ env }))).toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).not.toContain('rk_live_NOTAREALSECRET1234');
    expect(rendered).not.toContain('supersecrettokenvalue');
    expect(rendered).toContain('[redacted]');
    expect(rendered).toContain('[redacted:CI_TOKEN]');
  });

  it.each(['x-callback-token:', 'Bearer', 'authorization:'])(
    'never lets a credential value arrive a poll after its %s header',
    async (prefix) => {
      stagedCloud([
        { run: RUNNING, log: logBody(`${prefix}\n`) },
        { run: COMPLETED, log: logBody(`${prefix}\nopaque-sensitive-value\n`, { done: true }) },
      ]);
      const out = io();
      expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
      const rendered = out.stdout.join('\n');
      expect(rendered).not.toContain('opaque-sensitive-value');
      expect(rendered).toContain('[redacted]');
    },
  );

  it('never releases a credential header line before the line carrying its value completes', async () => {
    // Poll two serves the value as an unterminated fragment: releasing the
    // header line there leaves the completed value with no context on poll
    // three, where it would print verbatim. The header must wait for the
    // line that carries its value.
    stagedCloud([
      { run: RUNNING, log: logBody('x-callback-token:\n') },
      { run: RUNNING, log: logBody('x-callback-token:\nopaque-sensitive-value') },
      { run: RUNNING, log: logBody('x-callback-token:\nopaque-sensitive-value\n') },
      { run: COMPLETED, log: logBody('x-callback-token:\nopaque-sensitive-value\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).not.toContain('opaque-sensitive-value');
    expect(rendered).toContain('x-callback-token:');
    expect(rendered).toContain('[redacted]');
  });

  it('does not spin when a held credential header precedes an unterminated tail', async () => {
    // `authorization:` + a bare `Bearer` line + a still-arriving tail made
    // the release cut grow onto `Bearer\n`, see the header again, and shrink
    // — forever, inside one poll. The follow must terminate and hold the
    // incomplete context instead.
    stagedCloud([
      { run: RUNNING, log: logBody('authorization:\nBearer\npartial-tail') },
      { run: COMPLETED, log: logBody('authorization:\nBearer\npartial-tail\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).not.toContain('partial-tail');
    expect(rendered).toContain('[redacted]');
  });

  it('holds a credential header that precedes a still-arriving multiline env secret', async () => {
    const env = { SERVICE_TOKEN: 'alpha\nbeta\ngamma' };
    stagedCloud([
      { run: RUNNING, log: logBody('x-callback-token:\nalpha\n') },
      { run: COMPLETED, log: logBody('x-callback-token:\nalpha\nbeta\ngamma\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live({ env }))).toBe(0);
    const rendered = out.stdout.join('\n');
    // Releasing the header with `alpha` leaves `beta\ngamma` without the
    // whole value the redactor needs — every fragment must stay held.
    expect(rendered).not.toContain('alpha');
    expect(rendered).not.toContain('beta');
    expect(rendered).not.toContain('gamma');
    expect(rendered).toContain('[redacted:SERVICE_TOKEN]');
  });

  it('holds an authorization scheme word whose credential value is still coming', async () => {
    stagedCloud([
      { run: RUNNING, log: logBody('authorization: Bearer\n') },
      { run: COMPLETED, log: logBody('authorization: Bearer\ntoken-material\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    const rendered = out.stdout.join('\n');
    // The scheme name stays visible — whole-log redaction keeps it too — but
    // the value that completed it on the second poll must never print.
    expect(rendered).toContain('Bearer');
    expect(rendered).not.toContain('token-material');
    expect(rendered).toContain('[redacted]');
  });

  it('never lets a credential JSON field value arrive a poll after its name', async () => {
    stagedCloud([
      { run: RUNNING, log: logBody('posting {"authToken": "opa') },
      { run: COMPLETED, log: logBody('posting {"authToken": "opaque-sensitive-value"}\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).not.toContain('opaque-sensitive-value');
    expect(rendered).not.toContain('"opa');
    expect(rendered).toContain('{"authToken": "[redacted]"}');
  });

  // A PEM in the environment is the shape a line-at-a-time redactor cannot
  // catch: no single line of it equals the value, so every line of key
  // material goes straight to stdout. The value is fake.
  const PEM = '-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_KEY_MATERIAL_1234567890\n-----END PRIVATE KEY-----';
  const PEM_ENV = { SERVICE_PRIVATE_KEY: PEM };

  it('redacts a multiline secret that arrives whole in one response', async () => {
    stagedCloud([{ run: COMPLETED, log: logBody(`credential dump:\n${PEM}\n`, { done: true }) }]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live({ env: PEM_ENV })))
      .toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).not.toContain('FAKE_PRIVATE_KEY_MATERIAL_1234567890');
    expect(rendered).not.toContain('BEGIN PRIVATE KEY');
    expect(out.stdout.slice(1, -1)).toEqual(['credential dump:', '[redacted:SERVICE_PRIVATE_KEY]']);
  });

  it('holds a multiline secret’s first lines back until the polls that complete it', async () => {
    const head = `credential dump:\n${PEM.split('\n')[0]!}\n`;
    const most = `credential dump:\n${PEM.split('\n').slice(0, 2).join('\n')}\n`;
    const whole = `credential dump:\n${PEM}\ndone\n`;
    // What stdout held when each poll's run record was answered, so a line
    // released late is distinguishable from one released at the drain.
    const seen: string[][] = [];
    const out = io();
    stagedCloud([
      { run: RUNNING, log: logBody(head) },
      { run: RUNNING, log: logBody(most) },
      { run: COMPLETED, log: logBody(whole, { done: true }) },
    ], (path) => { if (path === 'run') seen.push([...out.stdout]); });
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live({ env: PEM_ENV })))
      .toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).not.toContain('FAKE_PRIVATE_KEY_MATERIAL_1234567890');
    expect(rendered).not.toContain('BEGIN PRIVATE KEY');
    expect(rendered).not.toContain('END PRIVATE KEY');
    expect(out.stdout.slice(1, -1)).toEqual(['credential dump:', '[redacted:SERVICE_PRIVATE_KEY]', 'done']);
    // The line before the secret is not held hostage by it: it left on the
    // first poll, and nothing of the key left before the third.
    expect(seen[1]!.slice(1)).toEqual(['credential dump:']);
    expect(seen[2]!.slice(1)).toEqual(['credential dump:']);
  });

  it('refuses a log that no longer begins with what was already shown', async () => {
    stagedCloud([
      { run: RUNNING, log: logBody('alpha\nbeta\n') },
      { run: RUNNING, log: logBody('rewritten\n') },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(1);
    expect(out.stderr[0]).toContain('REFUSED [cloud_log_rewritten]');
    expect(out.stderr[0]).toContain('would skip or repeat output');
    expect(out.stdout.slice(1)).toEqual(['alpha', 'beta']);
  });

  it('refuses `--follow --step` before it sends a request', async () => {
    const server = stagedCloud([{ run: RUNNING }]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: 'agent-5', json: false }, out.io, live())).toBe(2);
    expect(server.requests).toEqual([]);
    expect(out.stderr[0]).toContain('REFUSED [invalid_invocation]');
    expect(out.stderr[0]).toContain('cannot follow a step transcript');
    expect(out.stderr[0]).toContain(`flows logs <run-id> --step <name>`);
  });
});

describe('refusals and retries', () => {
  it('refuses a run this credential cannot see, printing no page', async () => {
    stagedCloud([{ run: { status: 404, body: { error: 'Run not found' } } }]);
    const watch = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, watch.io, live())).toBe(2);
    expect(watch.stdout).toEqual([]);
    expect(watch.stderr[0]).toContain('REFUSED [cloud_run_not_found]');

    stagedCloud([{ run: { status: 401, body: { error: 'Unauthorized' } } }]);
    const follow = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, follow.io, live())).toBe(2);
    expect(follow.stdout).toEqual([]);
    expect(follow.stderr[0]).toContain('REFUSED [cloud_auth_rejected]');
  });

  it('retries a 503 with a growing, capped delay and resets after a good tick', async () => {
    const clock = recorder();
    stagedCloud([
      { run: { status: 503, body: { error: 'busy' } } },
      { run: { status: 503, body: { error: 'busy' } } },
      { run: { status: 503, body: { error: 'busy' } } },
      { run: RUNNING, steps: stepsBody([]) },
      { run: { status: 503, body: { error: 'busy' } } },
      { run: COMPLETED, steps: stepsBody([]) },
    ]);
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io,
      live({ sleep: clock.sleep, pollIntervalMs: 20_000 }))).toBe(0);
    // 20s, 40s, then the 30s cap; then the interval after a good tick, and
    // the first backoff again — the failure count reset with the good tick.
    expect(clock.delays).toEqual([20_000, 30_000, 30_000, 20_000, 20_000]);
    expect(out.stdout).toHaveLength(2);
    expect(out.stderr).toEqual([]);
  });

  it('leaves the previous page and the consumed log alone when a poll fails', async () => {
    stagedCloud([
      { run: RUNNING, log: logBody('alpha\n') },
      { run: { status: 500, body: { error: 'boom' } } },
      { run: COMPLETED, log: logBody('alpha\nbeta\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout.slice(1)).toEqual(['alpha', 'beta', `COMPLETED ${RUN} completionReason: success`]);
    expect(out.stderr).toEqual([]);
  });

  it('retries a transient failure while draining the final tail rather than dropping it', async () => {
    stagedCloud([
      { run: COMPLETED, log: { status: 429, body: { error: 'slow down' } } },
      { run: COMPLETED, log: logBody('tail\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io, live())).toBe(0);
    expect(out.stdout.slice(1, -1)).toEqual(['tail']);
  });
});

describe('cancellation', () => {
  it('stops before the first request when the signal is already aborted', async () => {
    const server = stagedCloud([{ run: RUNNING, steps: stepsBody([]) }]);
    const controller = new AbortController();
    controller.abort();
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io,
      live({ signal: controller.signal }))).toBe(1);
    expect(server.requests).toEqual([]);
    expect(out.stdout).toEqual([]);
    expect(out.stderr[0]).toBe(`REFUSED [observation_aborted] Stopped watching run ${RUN}; `
      + 'the hosted run has not been cancelled.');
  });

  it('prints no partial frame when the abort lands between the two reads', async () => {
    const controller = new AbortController();
    stagedCloud([{ run: RUNNING, steps: stepsBody([stepRow()]) }], (route) => {
      if (route === 'steps') controller.abort();
    });
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io,
      live({ signal: controller.signal }))).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr[0]).toContain('observation_aborted');
  });

  it('stops during the sleep between frames, leaving the frames already drawn', async () => {
    const controller = new AbortController();
    stagedCloud([{ run: RUNNING, steps: stepsBody([stepRow()]) }]);
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io,
      live({ signal: controller.signal, sleep: async () => { controller.abort(); } }))).toBe(1);
    expect(out.stdout).toHaveLength(1);
    expect(out.stderr[0]).toContain('observation_aborted');
  });

  it('stops a follow without printing a fragment or a footer', async () => {
    const controller = new AbortController();
    stagedCloud([{ run: RUNNING, log: logBody('whole\nfrag') }]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: false }, out.io,
      live({ signal: controller.signal, sleep: async () => { controller.abort(); } }))).toBe(1);
    expect(out.stdout.slice(1)).toEqual(['whole']);
    expect(out.stdout.join('\n')).not.toContain('frag');
    expect(out.stdout.join('\n')).not.toContain('completionReason');
    expect(out.stderr[0]).toBe(`REFUSED [observation_aborted] Stopped following run ${RUN}; `
      + 'the hosted run has not been cancelled.');
  });

  it('reports an aborted fetch as the abort it was, not as a read failure', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const out = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: false }, out.io,
      live({ signal: controller.signal }))).toBe(1);
    expect(out.stderr[0]).toContain('observation_aborted');
  });

  it('installs no process signal handler of its own', async () => {
    const controller = new AbortController();
    const before = process.listenerCount('SIGINT');
    stagedCloud([{ run: RUNNING, steps: stepsBody([]) }]);
    await runCloudStatusWatch({ runId: RUN, json: false }, io().io,
      live({ signal: controller.signal, sleep: async () => { controller.abort(); } }));
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('--json', () => {
  it('polls silently and emits one status document at the end', async () => {
    stagedCloud([
      { run: RUNNING, steps: stepsBody([stepRow()]) },
      { run: COMPLETED, steps: stepsBody([stepRow({ status: 'completed', completionReason: 'success', durationMs: 1 })]) },
    ]);
    const out = io(true);
    expect(await runCloudStatusWatch({ runId: RUN, json: true }, out.io, live())).toBe(0);
    expect(out.stdout).toHaveLength(1);
    expect(out.stdout[0]).not.toContain('\u001b');
    const payload = JSON.parse(out.stdout[0]!) as { v: number; ok: boolean; run: { status: string }; now_ms: number };
    expect(payload).toMatchObject({ v: 1, ok: true, now_ms: NOW });
    expect(payload.run.status).toBe('completed');
  });

  it('emits one log document carrying the whole redacted content', async () => {
    const env = { CI_TOKEN: 'supersecrettokenvalue' };
    stagedCloud([
      { run: RUNNING, log: logBody('one\n') },
      { run: FAILED, log: logBody('one\ntwo supersecrettokenvalue\n', { done: true }) },
    ]);
    const out = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: true }, out.io, live({ env }))).toBe(1);
    expect(out.stdout).toHaveLength(1);
    const payload = JSON.parse(out.stdout[0]!) as { ok: boolean; content: string; done: boolean; step: null };
    expect(payload.ok).toBe(true);
    expect(payload.done).toBe(true);
    expect(payload.step).toBeNull();
    expect(payload.content).toBe('one\ntwo [redacted:CI_TOKEN]\n');
  });

  it('emits one refusal document and no partial output when aborted or refused', async () => {
    const controller = new AbortController();
    stagedCloud([{ run: RUNNING, log: logBody('one\n') }]);
    const stopped = io();
    expect(await runCloudLogsFollow({ runId: RUN, step: undefined, json: true }, stopped.io,
      live({ signal: controller.signal, sleep: async () => { controller.abort(); } }))).toBe(1);
    expect(stopped.stdout).toHaveLength(1);
    expect(JSON.parse(stopped.stdout[0]!)).toMatchObject({ v: 1, ok: false, code: 'observation_aborted' });
    expect(stopped.stderr).toEqual([]);

    stagedCloud([{ run: { status: 404, body: { error: 'Run not found' } } }]);
    const refused = io();
    expect(await runCloudStatusWatch({ runId: RUN, json: true }, refused.io, live())).toBe(2);
    expect(refused.stdout).toHaveLength(1);
    expect(JSON.parse(refused.stdout[0]!)).toMatchObject({ v: 1, ok: false, code: 'cloud_run_not_found' });
  });
});

describe('argv and wiring', () => {
  it('accepts the two flags, and refuses the invocations that contradict', () => {
    expect(parseStatusArgs(['--cloud', '--watch', RUN])).toMatchObject({ cloud: true, watch: true, runId: RUN });
    // Local status opens one journal file and returns; there is no loop to watch.
    expect(parseStatusArgs(['--watch', RUN])).toBeUndefined();
    expect(parseStatusArgs(['--cloud', '--watch', '--watch', RUN])).toBeUndefined();
    expect(parseStatusArgs(['--cloud', '--watch'])).toBeUndefined();
    expect(parseStatusArgs(['--cloud', '--watch', '--tail', '5', RUN])).toBeUndefined();
    expect(parseStatusArgs(['--cloud', '--watch', '--data-dir', '/tmp/x', RUN])).toBeUndefined();

    expect(parseLogsArgs([RUN, '--follow'])).toMatchObject({ runId: RUN, follow: true, step: undefined });
    expect(parseLogsArgs([RUN, '--follow', '--follow'])).toBeUndefined();
    expect(parseLogsArgs(['--follow'])).toBeUndefined();
  });

  it('routes both live invocations through runCli, and refuses a missing run id', async () => {
    vi.stubEnv('FLOWS_CLOUD_URL', 'https://cloud-contract.example');
    vi.stubEnv('FLOWS_CLOUD_TOKEN', 'test-scoped-cloud-token');

    stagedCloud([{ run: COMPLETED, steps: stepsBody([]) }]);
    const watched = io();
    expect(await runCli(['status', '--cloud', '--watch', '--json', RUN], watched.io)).toBe(0);
    expect(JSON.parse(watched.stdout[0]!)).toMatchObject({ ok: true });

    stagedCloud([{ run: FAILED, log: logBody('x\n', { done: true }) }]);
    const followed = io();
    expect(await runCli(['logs', '--follow', RUN], followed.io)).toBe(1);
    expect(followed.stdout.at(-1)).toBe(`FAILED ${RUN} completionReason: step_failed`);

    const refused = io();
    expect(await runCloudStatusWatch({ json: false }, refused.io, live())).toBe(2);
    expect(refused.stderr[0]).toContain('REFUSED [run_unknown]');
  });

  it('lists both flags in --help', async () => {
    const help = io();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.stdout[0]).toContain('flows status --cloud [--json] [--watch] <run-id>');
    expect(help.stdout[0]).toContain('flows logs [--step <name>] [--raw] [--json] [--follow] <run-id>');
  });
});
