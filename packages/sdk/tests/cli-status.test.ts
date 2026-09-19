import * as fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import { runCli } from '../src/cli.js';
import { parseStatusArgs, runStatus, type StatusOptions } from '../src/cli/status.js';
import type { JournalEvent } from '../src/journal-client.js';
import { runAgentCli } from '../src/worker-cli.js';
import { writeJournalFixture } from './journal-fixture.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EVENTS = readFileSync(join(ROOT, 'docs/evidence/journal-close-0909/completed.journal.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as JournalEvent);
const RUN_ID = EVENTS[0]!.run_id;
const CLI = join(ROOT, 'packages/sdk/dist/cli.js');
const T_END = EVENTS.at(-1)!.at_ms;
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cli-status-'));
  directories.push(directory);
  return directory;
}

function fixture(events = EVENTS, runId = RUN_ID) {
  const dataDir = temporaryDirectory();
  const { path, writer } = writeJournalFixture(dataDir, runId, events);
  return { dataDir, path, writer };
}

async function status(argv: string[], options: StatusOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const parsed = parseStatusArgs(argv);
  expect(parsed, `\`flows status ${argv.join(' ')}\` did not parse`).toBeDefined();
  const code = await runStatus(parsed!, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    { env: {}, now: () => T_END + 60_000, ...options });
  return { code, stdout, stderr };
}

function diskState(directory: string): unknown {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const info = statSync(path);
    return [name, info.mtimeMs, info.isDirectory() ? diskState(path) : createHash('sha256').update(readFileSync(path)).digest('hex')];
  });
}

/** The completed fixture with `implement` re-running: a failed attempt, then a live second one. */
function inFlight(detail: string): JournalEvent[] {
  const [spawned, routed, started, done] = EVENTS.slice(0, 4) as [JournalEvent, JournalEvent, JournalEvent, JournalEvent];
  const failed: JournalEvent = {
    ...done, seq: 4, payload: {
      ...done.payload as Record<string, unknown>, completionReason: 'worker_error', disposition: 'retry', output: null,
      verification: { gate: 'execution', verdict: 'fail', detail }, next_attempt_at_ms: done.at_ms + 1000,
    },
  };
  const again: JournalEvent = {
    ...started, seq: 5, attempt: 2, at_ms: done.at_ms + 1000,
    payload: { ...started.payload as Record<string, unknown>, lease_deadline_ms: T_END + 90_000 },
  };
  return [spawned, routed, started, failed, again];
}

describe('flows status', () => {
  it('renders the completed fixture as text without touching the daemon or the data dir', async () => {
    const { dataDir, writer } = fixture();
    writer.close();
    const before = diskState(dataDir);
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('status opened a socket'); });
    const output = await status(['--data-dir', dataDir, RUN_ID]);
    expect(output.code).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toEqual([
      `RUN ${RUN_ID}   journal-close-repro   completed   started 1m35s ago   finished success   spend 0 in / 0 out / $0`,
      'steps 3: 3 done',
      '',
      '  ✓ implement  agent          done         1 attempt  0.0s  success  gate: output_contains pass',
      '      artifacts (attempt 1): none journaled (output was a JSON object)',
      '  ✓ verify     deterministic  done         1 attempt  35.2s  success  gate: exit_code pass',
      '  ✓ report     deterministic  done         1 attempt  0.0s  success  gate: exit_code pass',
    ]);
    expect(connect).not.toHaveBeenCalled();
    expect(diskState(dataDir)).toEqual(before);
    expect(existsSync(join(dataDir, 'connection.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'relayflowd.sock'))).toBe(false);
  });

  it('--json is one canonical object with the documented shape and nothing from the spec or outputs', async () => {
    const { dataDir, writer } = fixture();
    writer.close();
    const output = await status(['--json', '--data-dir', dataDir, RUN_ID]);
    expect(output.code).toBe(0);
    expect(output.stdout).toHaveLength(1);
    const view = JSON.parse(output.stdout[0]!);
    expect(view).toMatchObject({
      v: 1, run_id: RUN_ID, name: 'journal-close-repro', status: 'completed', completion_reason: 'success',
      spawned_at_ms: EVENTS[0]!.at_ms, now_ms: T_END + 60_000, this_step: null, partial: [],
      spend: { tokens_in: 0, tokens_out: 0, dollars: '0', dollars_unmetered: false },
      counts: { total: 3, done: 3, running: 0, pending: 0, backoff: 0, waiting: 0, needs_human: 0 },
    });
    expect(view.steps).toHaveLength(3);
    expect(Object.keys(view.steps[0]).sort()).toEqual([
      'artifacts', 'attempt', 'backoff_until_ms', 'elapsed_ms', 'id', 'last_attempt', 'lease',
      'max_iterations', 'started_at_ms', 'state', 'tails', 'type', 'wait',
    ]);
    expect(view.steps[0].tails).toBeNull();
    // Canonical: sorted keys, no whitespace, so two invocations diff clean.
    expect(output.stdout[0]).toBe(canonicalize(view));
    for (const forbidden of ['instruction', 'Print DONE', 'stdout_tail', 'VERIFIED', 'REPORTED', 'wake_context', 'input', 'pins', 'idempotency_key', 'surface_path']) {
      expect(output.stdout[0], forbidden).not.toContain(forbidden);
    }
  });

  it('is dispatched by the CLI and refuses with run_unknown when nothing names a run', async () => {
    const stderr: string[] = [];
    const saved = process.env['RELAYFLOW_RUN_ID'];
    delete process.env['RELAYFLOW_RUN_ID'];
    try {
      const code = await runCli(['status'], { stdout: () => { throw new Error('nothing to print'); }, stderr: (line) => stderr.push(line) });
      expect(code).toBe(2);
      expect(stderr).toEqual(['REFUSED [run_unknown] pass <run-id> or run inside a step (RELAYFLOW_RUN_ID unset)']);
    } finally {
      if (saved !== undefined) process.env['RELAYFLOW_RUN_ID'] = saved;
    }
  });

  it('discovers the run from the step environment and marks this step', async () => {
    const { dataDir, writer } = fixture(inFlight('CLI invocation timed out after 600000ms.'));
    writer.close();
    const env = { RELAYFLOW_RUN_ID: RUN_ID, RELAYFLOW_DATA_DIR: dataDir, RELAYFLOW_STEP_ID: 'implement', RELAYFLOW_ATTEMPT: '2' };
    const output = await status([], { env });
    expect(output.code).toBe(0);
    expect(output.stdout).toEqual([
      `RUN ${RUN_ID}   journal-close-repro   running   started 1m35s ago   spend 0 in / 0 out / $0`,
      'steps 3: 1 running · 2 pending',
      '',
      '  ↻ implement  agent          running      attempt 2/1  1m34s  lease ok (expires in 30.0s)  ← this step',
      '      last attempt 1: worker_error → retry',
      '        gate: execution FAIL — "CLI invocation timed out after 600000ms."',
      '      artifacts (attempt 1): none journaled (output was a JSON object)',
      '  ○ verify     deterministic  pending',
      '  ○ report     deterministic  pending',
    ]);
    const json = await status(['--json'], { env });
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({ this_step: 'implement', status: 'running', counts: { running: 1, pending: 2 } });
    // An explicit run id is an operator asking about some run, not a step asking about itself.
    const explicit = await status(['--data-dir', dataDir, RUN_ID], { env });
    expect(explicit.stdout[3]).not.toContain('← this step');
  });

  it('shows an overdue lease from the clock alone', async () => {
    const { dataDir, writer } = fixture(inFlight('x'));
    writer.close();
    const output = await status(['--data-dir', dataDir, RUN_ID], { now: () => T_END + 90_000 + 41_000 });
    expect(output.stdout[3]).toContain('LEASE OVERDUE by 41.0s');
    const json = await status(['--json', '--data-dir', dataDir, RUN_ID], { now: () => T_END + 90_000 + 41_000 });
    expect(JSON.parse(json.stdout[0]!).steps[0].lease).toEqual({ deadline_ms: T_END + 90_000, overdue_ms: 41_000 });
  });

  it('redacts secrets in a gate detail in both renderings and caps it', async () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
    const leaked = `token=${secret} header Authorization: Bearer abc.def key rk_live_zzz ${'x'.repeat(2000)}`;
    const { dataDir, writer } = fixture(inFlight(leaked));
    writer.close();
    const env = { GITHUB_TOKEN: secret };
    const text = await status(['--data-dir', dataDir, RUN_ID], { env });
    const json = await status(['--json', '--data-dir', dataDir, RUN_ID], { env });
    for (const line of [...text.stdout, ...json.stdout]) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain('abc.def');
      expect(line).not.toContain('rk_live_zzz');
    }
    const detail = JSON.parse(json.stdout[0]!).steps[0].last_attempt.verification.detail as string;
    expect(detail.startsWith('token=[redacted:GITHUB_TOKEN] header Authorization: Bearer [redacted] key [redacted] ')).toBe(true);
    expect(detail.length).toBe(1024);
  });

  it('--tail says when no transcript is on disk for the attempt', async () => {
    const { dataDir, writer } = fixture(inFlight('x'));
    writer.close();
    const output = await status(['--tail', '5', '--data-dir', dataDir, RUN_ID]);
    expect(output.stdout).toContain('      stdout tail: no transcript on disk for attempt 2');
    expect(output.stdout).toContain('      stderr tail: no transcript on disk for attempt 2');
    // Deterministic steps have no agent transcript to speak of.
    expect(output.stdout.filter((line) => line.includes('tail:'))).toHaveLength(2);
  });

  it.each([
    [['--json', '--json'], 'duplicate flag'],
    [['--tail'], 'missing value'],
    [['--tail', 'many'], 'non-numeric tail'],
    [['--data-dir'], 'missing data dir'],
    [['a', 'b'], 'two run ids'],
    [['--at', 'step'], 'flag from another verb'],
  ])('refuses to parse %j (%s)', (argv) => {
    expect(parseStatusArgs(argv)).toBeUndefined();
  });

  it('refuses run_not_found without creating anything', async () => {
    const dataDir = join(temporaryDirectory(), 'absent');
    const output = await status(['--data-dir', dataDir, RUN_ID]);
    expect(output.code).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain('REFUSED [run_not_found]');
    expect(readdirSync(dirname(dataDir))).toEqual([]);
  });

  it('does not inherit replay\'s human-influenced refusal', async () => {
    const { dataDir, writer } = fixture();
    writer.exec("UPDATE entries SET payload = json_set(payload, '$.human_intervention', json('true')) WHERE seq = 4");
    writer.close();
    const output = await status(['--json', '--data-dir', dataDir, RUN_ID]);
    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout[0]!).steps[0].last_attempt.human_intervention).toBe(true);
  });

  it('retries a busy journal and renders once a consistent snapshot is taken', async () => {
    const { dataDir, path, writer } = fixture();
    writer.close();
    const originalCopy = fsPromises.copyFile;
    let copies = 0;
    vi.spyOn(fsPromises, 'copyFile').mockImplementation(async (source, destination, mode) => {
      await originalCopy(source, destination, mode);
      // Two busy snapshots, then the writer goes quiet.
      if (copies++ < 2) writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('changed')]));
    });
    const slept: number[] = [];
    const output = await status(['--json', '--data-dir', dataDir, RUN_ID], { sleep: async (ms) => { slept.push(ms); } });
    expect(output.code).toBe(0);
    expect(slept).toEqual([50, 50]);
    expect(JSON.parse(output.stdout[0]!).partial).toEqual([]);
  });

  it('refuses journal_busy after five busy snapshots, having rendered nothing it cannot vouch for', async () => {
    const { dataDir, path, writer } = fixture();
    writer.close();
    const originalCopy = fsPromises.copyFile;
    vi.spyOn(fsPromises, 'copyFile').mockImplementation(async (source, destination, mode) => {
      await originalCopy(source, destination, mode);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('changed')]));
    });
    const slept: number[] = [];
    const output = await status(['--data-dir', dataDir, RUN_ID], { sleep: async (ms) => { slept.push(ms); } });
    expect(output.code).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(slept).toEqual([50, 50, 50, 50]);
    expect(output.stderr[0]).toMatch(/^REFUSED \[journal_busy\] .*retry/);
  });

  it('resolves the run with no arguments from inside a worker-spawned agent', async () => {
    const { dataDir, writer } = fixture(inFlight('x'));
    writer.close();
    // The "agent" is the pinned CLI asking about itself: no arguments, no daemon, no credential.
    const claude = join(dataDir, 'claude');
    writeFileSync(claude, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const child = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'status', '--json'], { encoding: 'utf8', cwd: '/' });
process.stdout.write(JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }));
`, { mode: 0o755 });
    const result = await runAgentCli(claude, 'inspect yourself', undefined, 'unpriced-test-model', undefined, undefined, 'agent', {
      dataDir, runId: RUN_ID, stepId: 'implement', attempt: 2, onDrive() {},
    });
    expect(result.exit_code).toBe(0);
    const inner = JSON.parse(result.stdout_tail);
    // stderr carries only Node's experimental-SQLite notice, never a refusal.
    expect(inner.stderr, inner.stderr).not.toMatch(/REFUSED|FAILED/);
    expect(inner.status, inner.stderr).toBe(0);
    expect(JSON.parse(inner.stdout)).toMatchObject({ run_id: RUN_ID, this_step: 'implement', status: 'running' });
  });

  it('renders what it could read, marks the section partial and exits 1 on a mid-journal parse error', async () => {
    const { dataDir, writer } = fixture();
    writer.exec("UPDATE entries SET payload = '{' WHERE seq = 7");
    writer.close();
    const output = await status(['--json', '--data-dir', dataDir, RUN_ID]);
    expect(output.code).toBe(1);
    const view = JSON.parse(output.stdout[0]!);
    expect(view.partial).toEqual(['journal_read_failed']);
    expect(view.status).toBe('running');
    expect(view.steps.map((step: { state: string }) => step.state)).toEqual(['done', 'running', 'pending']);
    expect(output.stderr[0]).toMatch(/^FAILED \[journal_read_failed\] .*Entry seq 7/);
    const text = await status(['--data-dir', dataDir, RUN_ID]);
    expect(text.code).toBe(1);
    expect(text.stdout[2]).toBe('partial: journal_read_failed');
  });
});
