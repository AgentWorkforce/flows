import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { classifyOutcome, emptyReport, type RunDiagnostic, type RunReport } from '../src/cli/run.js';
import { EXCERPT_BYTES } from '../src/cli/step-excerpt.js';
import { socketPathFor } from '../src/daemon-connection.js';
import * as daemonLifecycle from '../src/daemon-lifecycle.js';
import { JournalClient } from '../src/journal-client.js';
import { PROTOCOL_VERSION, type RunOutcome } from '../src/protocol.js';

const failure: RunOutcome = {
  run_id: 'run-failed', status: 'failed', completion_reason: 'step_failed', completed_steps: 0,
};
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function completion(seq: number, stderr = '', exitCode = 7, stepId = 'fail-command', disposition = 'step_done') {
  return {
    seq, entry_type: 'step.completed', step_id: stepId,
    payload: {
      completionReason: exitCode === 0 ? 'success' : 'verification_failed', disposition,
      output: exitCode === 0 ? { exit_code: exitCode, stderr_tail: stderr } : null,
      ...(exitCode !== 0 ? { trajectory_tail: { exit_code: exitCode, stderr_tail: stderr } } : {}),
    },
  };
}

function stub(pages: unknown[][], type: 'deterministic' | 'agent' | 'llm' = 'deterministic') {
  const runGet = vi.fn(async () => ({ steps: { 'fail-command': { type, state: 'done' } } }));
  const journalRead = vi.fn(async () => ({ entries: pages.shift() ?? [] }));
  return { client: { runGet, journalRead } as unknown as JournalClient, runGet, journalRead };
}

async function classify(client: JournalClient, outcome = failure) {
  return classifyOutcome(client, 'run', outcome, emptyReport('run'), '/tmp/diagnostic.sock', {});
}

/** A TAP run whose failing case is at `failing` and whose totals come last. */
function tapRun(cases: number, failing: number): string {
  const lines = ['TAP version 13'];
  for (let index = 1; index <= cases; index++) {
    lines.push(index === failing
      ? `not ok ${index} - pty-exit: child reaped twice`
      : `ok ${index} - pty: a passing case with a realistically long name`);
  }
  lines.push(`1..${cases}`, `# tests ${cases}`, `# pass ${cases - 1}`, '# fail 1');
  return lines.join('\n') + '\n';
}

async function diagnosticFor(stderr: string) {
  const { client } = stub([[completion(1, stderr)]]);
  return (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
}

describe('step failure diagnostic', () => {
  it.each([false, true])('surfaces command exit, stderr and replay hint through the CLI (json=%s)', async json => {
    const dir = mkdtempSync(join(tmpdir(), 'flows-failure-'));
    directories.push(dir);
    writeFileSync(join(dir, 'flows.json'), '{}');
    const command = 'printf "shakedown intentional failure" >&2; exit 7';
    const path = join(dir, 'runtime-error.yaml');
    writeFileSync(path, `version: "0.1.0"\nname: runtime-error\nsteps:\n  - id: fail-command\n    type: deterministic\n    command: '${command}'\n`);
    // Execute the repro and supply the kernel's completion shape at the
    // client boundary. This tests CLI formatting independently of transport.
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    vi.spyOn(daemonLifecycle, 'ensureDaemon').mockResolvedValue({
      kind: 'attached', socketPath: socketPathFor(dir), connection: null,
    });
    vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({ protocol: PROTOCOL_VERSION, server: 'relayflowd-test' });
    vi.spyOn(JournalClient.prototype, 'runStart').mockResolvedValue(failure);
    vi.spyOn(JournalClient.prototype, 'runGet').mockResolvedValue({
      run_id: failure.run_id, status: 'failed', budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      steps: { 'fail-command': { type: 'deterministic', state: 'done' } },
    });
    vi.spyOn(JournalClient.prototype, 'journalRead').mockImplementation(async (_runId, fromSeq) => ({
      entries: fromSeq === 1 ? [completion(1, result.stderr, result.status!)] : [],
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['run', '--no-spawn', '--data-dir', dir, ...(json ? ['--json'] : []), path], {
      stdout: line => stdout.push(line), stderr: line => stderr.push(line),
    });
    expect(code).toBe(1);
    if (json) {
      const report = JSON.parse(stdout.join('\n')) as RunReport;
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        kind: 'step_failed', stepId: 'fail-command', stepType: 'deterministic',
        completionReason: 'verification_failed', exitCode: 7,
        stderrTail: 'shakedown intentional failure',
        // The hint has to name the non-default data dir, or replaying it from
        // the operator's shell would look in the wrong place.
        hint: `flows replay run-failed --at fail-command --data-dir '${dir}'`,
        journalPath: join(dir, 'runs', 'run-failed.sqlite3'),
      }));
    } else {
      const output = stderr.join('\n');
      expect(output).toContain('FAILED [step_failed]');
      expect(output).toContain('exit=7');
      expect(output).toContain('shakedown intentional failure');
      expect(output).toContain('flows replay run-failed --at fail-command');
      expect(output).toContain(join(dir, 'runs', 'run-failed.sqlite3'));
    }
  });

  it.each([false, true])('exposes the middle failure through the CLI itself (json=%s)', async json => {
    // The unit above proves the renderer; this proves the whole CLI path,
    // human and machine-readable, carries the failing case to the operator.
    const dir = mkdtempSync(join(tmpdir(), 'flows-failure-'));
    directories.push(dir);
    writeFileSync(join(dir, 'flows.json'), '{}');
    const path = join(dir, 'tap-run.yaml');
    writeFileSync(path, 'version: "0.1.0"\nname: tap-run\nsteps:\n  - id: fail-command\n    type: deterministic\n    command: \'node --test\'\n');
    const stream = tapRun(400, 200);
    vi.spyOn(daemonLifecycle, 'ensureDaemon').mockResolvedValue({
      kind: 'attached', socketPath: socketPathFor(dir), connection: null,
    });
    vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({ protocol: PROTOCOL_VERSION, server: 'relayflowd-test' });
    vi.spyOn(JournalClient.prototype, 'runStart').mockResolvedValue(failure);
    vi.spyOn(JournalClient.prototype, 'runGet').mockResolvedValue({
      run_id: failure.run_id, status: 'failed', budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      steps: { 'fail-command': { type: 'deterministic', state: 'done' } },
    });
    vi.spyOn(JournalClient.prototype, 'journalRead').mockImplementation(async (_runId, fromSeq) => ({
      entries: fromSeq === 1 ? [completion(1, stream, 1)] : [],
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['run', '--no-spawn', '--data-dir', dir, ...(json ? ['--json'] : []), path], {
      stdout: line => stdout.push(line), stderr: line => stderr.push(line),
    });
    expect(code).toBe(1);
    const output = json ? stdout.join('\n') : stderr.join('\n');
    expect(output).toContain('not ok 200 - pty-exit: child reaped twice');
    if (json) {
      const report = JSON.parse(output) as RunReport;
      // `at(-1)` is not stable: a failed run can append a trailing
      // protocol_error when the subscription snapshot cannot be inspected.
      const diagnostic = report.diagnostics.find(entry => entry.kind === 'step_failed') as RunDiagnostic;
      expect(diagnostic.stderrTail).toContain('not ok 200 - pty-exit: child reaped twice');
      expect(Buffer.byteLength(diagnostic.stderrTail!)).toBeLessThanOrEqual(EXCERPT_BYTES);
    }
  });

  it('keeps the head the last-1,024-bytes render discarded outright', async () => {
    // This assertion is the inverse of the one it replaces, and the inversion
    // is the bug: `discarded-prefix` is the head of the stream, and a render
    // that could only ever show its last kilobyte threw it away.
    const diagnostic = await diagnosticFor('discarded-prefix\n' + 'x\n'.repeat(4_000) + 'last error\n');
    expect(diagnostic.stderrTail).toContain('discarded-prefix');
    expect(diagnostic.stderrTail).toContain('last error');
    expect(diagnostic.stderrTail).toMatch(/… [\d,]+ bytes elided …/u);
    expect(diagnostic.message).toContain('discarded-prefix');
    expect(Buffer.byteLength(diagnostic.stderrTail!)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('names the failing case from the middle of a streamed test run', async () => {
    // The reported case. A runner that streams results and prints its totals
    // last puts `ok` lines and a summary in the final kilobyte by
    // construction, so the one `not ok` was exactly the part that got cut.
    const diagnostic = await diagnosticFor(tapRun(400, 200));
    expect(diagnostic.message).toContain('Stderr (captured excerpt):');
    expect(diagnostic.message).toContain('not ok 200 - pty-exit: child reaped twice');
    expect(diagnostic.message).toContain('# fail 1');
    expect(diagnostic.message).toContain('TAP version 13');
  });

  it('returns a stream that fits whole, so no marker means no elision', async () => {
    const stream = tapRun(14, 5);
    expect(Buffer.byteLength(stream)).toBeLessThan(EXCERPT_BYTES);
    const diagnostic = await diagnosticFor(stream);
    expect(diagnostic.stderrTail).toBe(stream);
    expect(diagnostic.stderrTail).not.toContain('elided');
  });

  it('truncates at UTF-8 boundaries without splitting multibyte characters', async () => {
    const diagnostic = await diagnosticFor('🙂'.repeat(2_000) + 'é');
    expect(Buffer.byteLength(diagnostic.stderrTail!)).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(diagnostic.stderrTail).not.toContain('\ufffd');
  });

  it('replaces binary and terminal controls and remains byte bounded', async () => {
    const binary = Buffer.from([0, 0xff, 0x1b, 13, 8]).toString('utf8');
    const diagnostic = await diagnosticFor(binary.repeat(1_000) + '\u009b31m\u202eEND\n\t');
    expect(diagnostic.stderrTail).toMatch(/END\n\t$/);
    expect(diagnostic.stderrTail).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}]/u);
    expect(Buffer.byteLength(diagnostic.stderrTail!)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('includes an empty stderr field for a silent nonzero exit', async () => {
    expect(await diagnosticFor('')).toMatchObject({ exitCode: 7, stderrTail: '' });
  });

  it('reads later pages and ignores failed attempts superseded by success', async () => {
    const { client, journalRead } = stub([
      [completion(1, 'old error', 8, 'fail-command', 'retry')],
      [completion(2, '', 0)],
      [completion(3, 'final error', 7)],
    ]);
    const report = (await classify(client)).report;
    expect(report.diagnostics.at(-1)).toMatchObject({ exitCode: 7, stderrTail: 'final error' });
    expect(journalRead.mock.calls).toEqual([
      ['run-failed', 1, 100], ['run-failed', 2, 100], ['run-failed', 3, 100], ['run-failed', 4, 100],
    ]);
  });

  it('does not report recovered attempts or successful command output', async () => {
    const { client } = stub([[completion(1, 'old error'), completion(2, 'success stderr', 0)]]);
    expect((await classify(client)).report.diagnostics.at(-1)).not.toHaveProperty('exitCode');
  });

  it.each(['agent', 'llm'] as const)('surfaces %s evidence the kernel kept in verification.detail', async type => {
    // This test used to assert the opposite — that the CLI read nothing for a
    // non-deterministic step — and so it pinned the bug rather than a
    // behaviour: a failed `f.agent` reported `step_failed` and discarded every
    // account of why. The kernel nulls `output` on a failed non-deterministic
    // completion (`preserve_failure_output`, relayflowd-core/src/machine.rs)
    // and keeps the worker's report only as the bounded render in
    // `verification.detail`, so that is where the reader has to look.
    const { client, journalRead } = stub([[{
      seq: 1, entry_type: 'step.completed', step_id: 'fail-command',
      payload: {
        completionReason: 'worker_error', disposition: 'step_done', output: null,
        verification: {
          gate: 'execution', verdict: 'fail',
          detail: '{"exit_code":1,"stdout_tail":"boot failed","stderr_tail":"no such model"}',
        },
      },
    }]], type);
    const diagnostic = (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
    expect(journalRead).toHaveBeenCalled();
    expect(diagnostic).toMatchObject({
      kind: 'step_failed', stepId: 'fail-command', stepType: type,
      completionReason: 'worker_error', exitCode: 1,
      stdoutTail: 'boot failed', stderrTail: 'no such model',
    });
    expect(diagnostic.message).toContain('no such model');
    expect(diagnostic.message).toContain('exit=1');
  });

  it('reads the transcript digest beside the daemon render, not instead of it', async () => {
    // Every agent completion now carries `trajectory_tail.transcript`
    // (agent-transcript.ts). It is not process-shaped, so the exit code and
    // tails still come from the daemon's render; the digest adds the failure
    // the worker picked out of the provider's frames and the file's path.
    const { client } = stub([[{
      seq: 1, entry_type: 'step.completed', step_id: 'fail-command',
      payload: {
        completionReason: 'worker_error', disposition: 'step_done', output: null,
        trajectory_tail: { transcript: {
          attempt: 2, exit_code: 1, failure: { kind: 'result', excerpt: 'Claude: budget exhausted' },
          file: { path: '/data/runs/run-failed/steps/fail-command/attempt-2.transcript.jsonl' },
        } },
        verification: {
          gate: 'execution', verdict: 'fail',
          detail: '{"exit_code":1,"stdout_tail":"","stderr_tail":"process stderr"}',
        },
      },
    }]], 'agent');
    const diagnostic = (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
    expect(diagnostic).toMatchObject({
      exitCode: 1, stderrTail: 'process stderr', detail: 'Claude: budget exhausted',
      transcriptPath: '/data/runs/run-failed/steps/fail-command/attempt-2.transcript.jsonl',
    });
    expect(diagnostic.message).toContain('exit=1');
    expect(diagnostic.message).toContain('Detail: Claude: budget exhausted');
    expect(diagnostic.message).toContain('Transcript: /data/runs/run-failed/steps/fail-command/attempt-2.transcript.jsonl');
  });

  it('does not print a stderr excerpt twice', async () => {
    const { client } = stub([[{
      seq: 1, entry_type: 'step.completed', step_id: 'fail-command',
      payload: {
        completionReason: 'worker_error', disposition: 'step_done', output: null,
        trajectory_tail: { transcript: { attempt: 1, exit_code: 1, failure: { kind: 'stderr', excerpt: 'no such model' } } },
        verification: { gate: 'execution', verdict: 'fail', detail: '{"exit_code":1,"stdout_tail":"","stderr_tail":"no such model"}' },
      },
    }]], 'llm');
    const diagnostic = (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
    expect(diagnostic).toMatchObject({ exitCode: 1, stderrTail: 'no such model' });
    expect(diagnostic).not.toHaveProperty('detail');
    expect(diagnostic).not.toHaveProperty('transcriptPath');
    expect(diagnostic.message.split('no such model')).toHaveLength(2);
  });

  it('keeps an unparseable daemon detail verbatim rather than dropping it', async () => {
    // `worker_failure_detail` renders a bare string as a bare string, and
    // truncates a long render past the point where it would still parse. Both
    // arrive here as prose, and prose is still an account of the failure.
    const { client } = stub([[{
      seq: 1, entry_type: 'step.completed', step_id: 'fail-command',
      payload: {
        completionReason: 'worker_error', disposition: 'step_done', output: null,
        verification: { gate: 'execution', verdict: 'fail', detail: 'analyzer exited 1: no such model' },
      },
    }]], 'agent');
    const diagnostic = (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
    expect(diagnostic.detail).toBe('analyzer exited 1: no such model');
    expect(diagnostic).not.toHaveProperty('exitCode');
    expect(diagnostic.message).toContain('analyzer exited 1: no such model');
  });

  it('says where to look without inventing evidence it does not have', async () => {
    const { client } = stub([[{
      seq: 1, entry_type: 'step.completed', step_id: 'fail-command',
      payload: { completionReason: 'crashed', disposition: 'step_done', output: null },
    }]], 'agent');
    const diagnostic = (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
    // Nothing was journaled beyond the reason, so nothing beyond it is claimed.
    expect(diagnostic).not.toHaveProperty('exitCode');
    expect(diagnostic).not.toHaveProperty('stderrTail');
    expect(diagnostic).not.toHaveProperty('detail');
    expect(diagnostic.completionReason).toBe('crashed');
    expect(diagnostic.message).toContain('completionReason: crashed');
    expect(diagnostic.message).toContain('Inspect: flows replay run-failed --at fail-command');
  });

  it('does not inspect the journal or change diagnostics on success', async () => {
    const { client, runGet, journalRead } = stub([]);
    const execution = await classify(client, { ...failure, status: 'completed', completion_reason: 'success', completed_steps: 1 });
    expect(execution.exitCode).toBe(0);
    expect(execution.report.diagnostics).toEqual([]);
    expect(runGet).not.toHaveBeenCalled();
    expect(journalRead).not.toHaveBeenCalled();
  });

  it('preserves step_failed, explains failed inspection, and still says where to look', async () => {
    const { client, journalRead } = stub([]);
    journalRead.mockRejectedValueOnce(new Error('journal unavailable'));
    const execution = await classify(client);
    expect(execution.exitCode).toBe(1);
    const diagnostic = execution.report.diagnostics.at(-1) as RunDiagnostic;
    expect(diagnostic.kind).toBe('step_failed');
    expect(diagnostic.message).toContain('Could not inspect the failed step: journal unavailable');
    // The footer comes from the run id alone, which is why it survives exactly
    // the case where the evidence itself could not be read.
    expect(diagnostic.message).toContain('Inspect: flows replay run-failed');
  });

  it('reads the attempt and the budget it was spent against from the journal', async () => {
    // `retries_exhausted` on a flow that asked for no retries read as if
    // retries had happened. They had not: the kernel's budget is
    // `max_iterations`, which it journals on every attempt start. Printing
    // the budget beside the reason is what makes the word unambiguous —
    // `attempt=1/1` cannot be read as "it retried".
    const { client } = stub([[
      { seq: 1, entry_type: 'step.attempt.started', step_id: 'fail-command', attempt: 1, payload: { max_iterations: 1 } },
      { ...completion(2), attempt: 1 },
    ]]);
    const diagnostic = (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
    expect(diagnostic).toMatchObject({ attempt: 1, maxIterations: 1 });
    expect(diagnostic.message).toContain('attempt=1/1');
  });

  it('reports the last attempt of a genuinely retried step, not the first', async () => {
    const { client } = stub([[
      { seq: 1, entry_type: 'step.attempt.started', step_id: 'fail-command', attempt: 1, payload: { max_iterations: 3 } },
      { ...completion(2, 'first', 8, 'fail-command', 'retry'), attempt: 1 },
      { seq: 3, entry_type: 'step.attempt.started', step_id: 'fail-command', attempt: 3, payload: { max_iterations: 3 } },
      { ...completion(4, 'last'), attempt: 3 },
    ]]);
    expect((await classify(client)).report.diagnostics.at(-1)).toMatchObject({
      attempt: 3, maxIterations: 3, stderrTail: 'last',
      message: expect.stringContaining('attempt=3/3'),
    });
  });

  it('claims no attempt facts when the journal carries none', async () => {
    // An older daemon journals no `max_iterations`. Defaulting the budget to
    // 1 would assert a retry policy nobody recorded.
    const diagnostic = await diagnosticFor('no attempt envelope');
    expect(diagnostic).not.toHaveProperty('attempt');
    expect(diagnostic).not.toHaveProperty('maxIterations');
    expect(diagnostic.message).not.toContain('attempt=');
  });

  it('stops on non-advancing journal pages', async () => {
    const { client } = stub([[completion(1)], [completion(1)]]);
    expect((await classify(client)).report.diagnostics.at(-1)).toMatchObject({
      kind: 'step_failed', message: expect.stringContaining('invalid journal sequence'),
    });
  });

  it('reads exit_code and stderr_tail from output (post-#292 canonical shape)', async () => {
    // Post-#292 the kernel emits the captured shape in `output` on failed
    // completions rather than routing it through `trajectory_tail`. The CLI
    // must surface the diagnostic from that field even when trajectory_tail
    // is absent.
    const post292Completion = {
      seq: 1, entry_type: 'step.completed', step_id: 'fail-command',
      payload: {
        completionReason: 'retries_exhausted', disposition: 'step_done',
        output: { exit_code: 7, stdout_tail: '', stderr_tail: 'post-292 stderr' },
        // trajectory_tail intentionally omitted — output is the canonical
        // carrier once the kernel fix has landed.
      },
    };
    const { client } = stub([[post292Completion]]);
    const diagnostic = (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
    expect(diagnostic).toMatchObject({
      kind: 'step_failed', stepId: 'fail-command', exitCode: 7,
      stderrTail: 'post-292 stderr',
      hint: 'flows replay run-failed --at fail-command',
    });
  });
});
