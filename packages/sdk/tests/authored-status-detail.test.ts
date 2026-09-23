// `flows status` on an authored run that said why it failed.
//
// The kernel facts stay exactly what the journal recorded — the root step
// succeeded, so the run completed with `success` — and the body's own verdict
// is a separate, labelled line beside them. Nothing here rewrites
// `run.completed` or makes a successful step look failed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authoredVerdictOf, AUTHORED_ROOT_KIND } from '../src/authored-verdict.js';
import { canonicalize } from '../src/canonical.js';
import { parseStatusArgs, runStatus, type StatusOptions } from '../src/cli/status.js';
import type { JournalEvent } from '../src/journal-client.js';
import { writeJournalFixture } from './journal-fixture.js';

const RUN_ID = '9e1a0f2c-5b0e-4a61-9f8c-1d2e3f4a5b6c';
const T0 = 1_760_000_000_000;
const FINDING = 'One P2 remains: cleanup can report success while an ambiguous '
  + 'allocation stays invisible through all three sweeps — `review.clean` was not created.';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface RootOptions {
  detail?: unknown;
  reason?: unknown;
  /** Omit the authored-root authority metadata: an ordinary flow may use the id. */
  kind?: string | null;
  disposition?: string;
  stepCompletionReason?: string;
  omitOutput?: boolean;
}

function journal(options: RootOptions = {}): JournalEvent[] {
  const instruction = options.kind === null ? 'just a task for an agent' : JSON.stringify({
    kind: options.kind ?? AUTHORED_ROOT_KIND,
    flowName: 'software-factory',
    flowPath: '/flows/software-factory.flow.ts',
    inputPresent: false,
  });
  const output = {
    name: 'software-factory',
    completionReason: options.reason ?? 'step_failed',
    journalSteps: [{ id: 'run-1', runId: 'child-1', completionReason: 'success' }],
    ...(options.detail === undefined ? {} : { completionDetail: options.detail }),
  };
  const event = (
    seq: number, entry_type: string, step_id: string | null, at_ms: number, payload: unknown,
  ): JournalEvent => ({ seq, segment_id: 1, entry_type, run_id: RUN_ID, step_id, attempt: step_id === null ? null : 1, at_ms, payload });
  return [
    event(1, 'run.spawned', null, T0, { spec: {
      name: 'software-factory', version: '0.1.0',
      steps: [{ id: 'authored-root', type: 'agent', instruction, depends_on: [] }],
    } }),
    event(2, 'step.attempt.started', 'authored-root', T0 + 10, { lease_deadline_ms: T0 + 30_000 }),
    event(3, 'step.completed', 'authored-root', T0 + 20_000, {
      completionReason: options.stepCompletionReason ?? 'success',
      disposition: options.disposition ?? 'step_done',
      ...(options.omitOutput === true ? {} : { output }),
    }),
    event(4, 'run.completed', null, T0 + 20_001, { completionReason: 'success' }),
  ];
}

function fixture(events: JournalEvent[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'authored-status-'));
  directories.push(dataDir);
  writeJournalFixture(dataDir, RUN_ID, events).writer.close();
  return dataDir;
}

async function status(argv: string[], options: StatusOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const parsed = parseStatusArgs(argv);
  expect(parsed, `\`flows status ${argv.join(' ')}\` did not parse`).toBeDefined();
  const code = await runStatus(parsed!, { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) },
    { env: {}, now: () => T0 + 60_000, ...options });
  return { code, stdout, stderr };
}

describe('projecting the authored verdict out of a root journal', () => {
  it('reads the verdict and its detail', () => {
    expect(authoredVerdictOf(journal({ detail: FINDING })))
      .toEqual({ reason: 'step_failed', detail: FINDING });
  });

  it('reads a verdict with no detail, and reports no detail key', () => {
    const verdict = authoredVerdictOf(journal())!;
    expect(verdict.reason).toBe('step_failed');
    expect('detail' in verdict).toBe(false);
  });

  it.each([
    ['an ordinary step that merely shares the name', { kind: null }],
    ['a root declaring some other authority kind', { kind: 'relayflows.something-else.v1' }],
    ['a completion that is a retry, not a terminal', { disposition: 'retry' }],
    ['a completion that parked', { disposition: 'park' }],
    ['a root step the kernel did not complete with success', { stepCompletionReason: 'worker_error' }],
    ['a completion carrying no output at all', { omitOutput: true }],
    ['an output whose reason is not a lowered completion', { reason: 'invented' }],
    ['an output whose detail is not a string', { detail: 7 }],
    ['an output whose detail is over the bound', { detail: 'a'.repeat(2001) }],
  ] as const)('attests nothing for %s', (_label, options) => {
    expect(authoredVerdictOf(journal(options))).toBeNull();
  });

  it('attests nothing for a journal that is not a run at all', () => {
    expect(authoredVerdictOf([])).toBeNull();
    expect(authoredVerdictOf(journal().slice(1))).toBeNull();
  });
});

describe('flows status on a detail-bearing authored run', () => {
  it('prints the authored verdict beside the kernel facts, not instead of them', async () => {
    const output = await status(['--data-dir', fixture(journal({ detail: FINDING })), RUN_ID]);

    expect(output.code).toBe(0);
    expect(output.stderr).toEqual([]);
    // The kernel's own account is unchanged and still first.
    expect(output.stdout[0]).toContain('completed');
    expect(output.stdout[0]).toContain('finished success');
    expect(output.stdout[1]).toBe(`authored done("step_failed"): ${FINDING}`);
    // …and the root step is still the success it was.
    expect(output.stdout.find((line) => line.includes('authored-root'))).toContain('✓');
  });

  it('keeps the full 2,000-code-point detail, past the gate-detail limit', async () => {
    const long = `${'a'.repeat(1_900)} the finding is at the very end`;
    const output = await status(['--data-dir', fixture(journal({ detail: long })), RUN_ID]);
    expect(output.stdout[1]).toBe(`authored done("step_failed"): ${long}`);
    expect(output.stdout[1]!.length).toBeGreaterThan(1_024);
  });

  it('folds a multiline detail onto one line and strips control characters', async () => {
    const multiline = 'P1: none\nP2: review.clean was not created\nP3: none\u0007';
    const output = await status(['--data-dir', fixture(journal({ detail: multiline })), RUN_ID]);
    expect(output.stdout[1])
      .toBe('authored done("step_failed"): P1: none\\nP2: review.clean was not created\\nP3: none\\u0007');
    // One line, not three: the breaks are escaped, not printed.
    expect(output.stdout[2]!.startsWith('steps ')).toBe(true);
  });

  it('exposes reason and detail in --json, canonically', async () => {
    const output = await status(['--json', '--data-dir', fixture(journal({ detail: FINDING })), RUN_ID]);
    const view = JSON.parse(output.stdout[0]!);
    expect(view.authored_completion).toEqual({ reason: 'step_failed', detail: FINDING });
    // The kernel facts are untouched.
    expect(view.status).toBe('completed');
    expect(view.completion_reason).toBe('success');
    expect(output.stdout[0]).toBe(canonicalize(view));
  });

  it('redacts a secret on the way out, in both renderings', async () => {
    const secret = 'super-secret-workspace-material';
    const detail = `review failed against ot_live_abc123DEF456 with key ${secret}`;
    const dataDir = fixture(journal({ detail }));
    const env = { RELAY_API_KEY: secret };
    const text = await status(['--data-dir', dataDir, RUN_ID], { env });
    const json = await status(['--json', '--data-dir', dataDir, RUN_ID], { env });
    for (const line of [...text.stdout, ...json.stdout]) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain('ot_live_abc123DEF456');
    }
    expect(text.stdout[1]).toContain('[redacted]');
    expect(text.stdout[1]).toContain('[redacted:RELAY_API_KEY]');
  });

  it.each([
    ['a one-argument done()', journal()],
    ['an ordinary run that happens to name a step authored-root', journal({ kind: null, detail: FINDING })],
    ['a malformed authored output', journal({ detail: 7 })],
  ])('adds no line and no JSON key for %s', async (_label, events) => {
    const dataDir = fixture(events);
    const text = await status(['--data-dir', dataDir, RUN_ID]);
    expect(text.stdout[1]).not.toContain('authored done(');
    expect(text.stdout[1]!.startsWith('steps ')).toBe(true);
    const json = await status(['--json', '--data-dir', dataDir, RUN_ID]);
    const view = JSON.parse(json.stdout[0]!);
    expect('authored_completion' in view).toBe(false);
    expect(json.stdout[0]).toBe(canonicalize(view));
  });
});
