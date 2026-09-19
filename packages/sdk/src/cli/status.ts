// `flows status`: what an agent can see about its own run, from disk.
//
// Read-only and offline. Opens exactly one file — the run's journal, through
// the same copy-then-verify `walkJournal` that `flows replay` uses — and never
// the registry, `connection.json`, the daemon socket or the network. There is
// no credential to hold because nothing here is authenticated: the journal is
// on the same filesystem as the process asking. Everything a hosted run knows
// about itself is in that file; whatever is not (its Cloud run id, its
// sandbox, its listener) is Cloud's to answer, and this verb does not guess.

import type { CliIo } from '../cli.js';
import { canonicalize } from '../canonical.js';
import { DEFAULT_DATA_DIR } from '../daemon-connection.js';
import { JournalReadError, walkJournal, type JournalEvent } from '../journal-client.js';
import { redact } from '../redact.js';
import { foldRunState, RunStateError, type RunView, type StepView } from '../run-state.js';
import { DATA_DIR_ENV, RUN_ID_ENV, STEP_ID_ENV } from '../step-env.js';

export interface StatusArgs {
  command: 'status';
  json: boolean;
  dataDir?: string;
  tail?: number;
  runId?: string;
}

export const DEFAULT_TAIL_LINES = 20;
/** A gate's `detail` may be 2,000 chars (engine/remote.rs); the view shows the head. */
const DETAIL_LIMIT = 1024;
const BUSY_RETRIES = 5;
const BUSY_RETRY_DELAY_MS = 50;

/** One transcript tail on disk, already redacted, as `--tail` renders it. */
export interface TranscriptTail {
  attempt: number;
  bytes: number;
  lines: string[];
}

export type StepTails = { stdout: TranscriptTail | null; stderr: TranscriptTail | null } | null;

/** How the verb finds transcript tails; `null` until the tail writer ships. */
export interface TailSource {
  read(dataDir: string, runId: string, step: StepView, lines: number): Promise<StepTails>;
}

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  tails?: TailSource;
  sleep?: (ms: number) => Promise<void>;
}

export function parseStatusArgs(args: readonly string[]): StatusArgs | undefined {
  let json = false;
  let dataDir: string | undefined;
  let tail: number | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
    } else if (argument === '--data-dir' || argument === '--tail') {
      const value = args[++index];
      if (value === undefined || value.length === 0 || value.startsWith('-')) return undefined;
      if (argument === '--data-dir') {
        if (dataDir !== undefined) return undefined;
        dataDir = value;
      } else {
        if (tail !== undefined || !/^\d{1,4}$/.test(value)) return undefined;
        tail = Number(value);
      }
    } else if (argument.startsWith('-')) {
      return undefined;
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length > 1) return undefined;
  return {
    command: 'status', json,
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(tail === undefined ? {} : { tail }),
    ...(positionals[0] === undefined ? {} : { runId: positionals[0] }),
  };
}

interface Snapshot {
  events: JournalEvent[];
  partial: string[];
  failure?: JournalReadError;
}

/**
 * Take one consistent snapshot of the journal. `journal_busy` means a writer
 * was mid-flight, so wait briefly and try again; any other mid-walk failure
 * keeps the events read so far and reports the section as partial.
 */
async function snapshot(runId: string, dataDir: string, sleep: (ms: number) => Promise<void>): Promise<Snapshot> {
  for (let attempt = 1; ; attempt += 1) {
    const events: JournalEvent[] = [];
    try {
      for await (const event of walkJournal(runId, dataDir)) events.push(event);
      return { events, partial: [] };
    } catch (error) {
      const failure = error instanceof JournalReadError ? error
        : new JournalReadError('journal_read_failed', error instanceof Error ? error.message : String(error));
      if (failure.code === 'journal_busy' && attempt < BUSY_RETRIES) { await sleep(BUSY_RETRY_DELAY_MS); continue; }
      return { events, partial: [failure.code], failure };
    }
  }
}

export async function runStatus(args: StatusArgs, io: CliIo, options: StatusOptions = {}): Promise<0 | 1 | 2> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Discovery: an explicit run id wins; otherwise the step's own identity from
  // the environment the worker set. A shared data dir holds other people's
  // runs, so there is no "list everything" mode to fall back to.
  const runId = args.runId ?? env[RUN_ID_ENV];
  if (runId === undefined || runId.length === 0) {
    io.stderr(`REFUSED [run_unknown] pass <run-id> or run inside a step (${RUN_ID_ENV} unset)`);
    return 2;
  }
  const dataDir = args.dataDir ?? env[DATA_DIR_ENV] ?? DEFAULT_DATA_DIR;
  const thisStep = args.runId === undefined ? env[STEP_ID_ENV] ?? null : null;

  const taken = await snapshot(runId, dataDir, sleep);
  if (taken.events.length === 0) {
    const failure = taken.failure ?? new JournalReadError('journal_read_failed', 'Journal holds no entries.');
    io.stderr(`REFUSED [${failure.code}] ${failure.message}`);
    return 2;
  }
  let view: RunView;
  try {
    view = foldRunState(taken.events, now());
  } catch (error) {
    const message = error instanceof RunStateError ? error.message : error instanceof Error ? error.message : String(error);
    io.stderr(`REFUSED [run_state_invalid] ${message}`);
    return 2;
  }

  const tails = new Map<string, StepTails>();
  if (options.tails !== undefined) {
    for (const step of view.steps) {
      try {
        tails.set(step.id, await options.tails.read(dataDir, runId, step, args.tail ?? DEFAULT_TAIL_LINES));
      } catch {
        if (!taken.partial.includes('transcript_tail_unreadable')) taken.partial.push('transcript_tail_unreadable');
        tails.set(step.id, null);
      }
    }
  }

  const presented = present(view, thisStep, tails, env);
  if (args.json) {
    io.stdout(canonicalize({ v: 1, ...presented, partial: taken.partial }));
  } else {
    for (const line of renderText(presented, taken.partial, args.tail !== undefined || options.tails !== undefined)) io.stdout(line);
  }
  if (taken.failure !== undefined) io.stderr(`FAILED [${taken.failure.code}] ${taken.failure.message}`);
  return taken.partial.length === 0 ? 0 : 1;
}

type PresentedStep = StepView & { tails: StepTails };
type Presented = Omit<RunView, 'steps'> & { this_step: string | null; steps: PresentedStep[] };

/** Apply the redaction and size bounds the on-disk model does not have. */
function present(view: RunView, thisStep: string | null, tails: Map<string, StepTails>, env: NodeJS.ProcessEnv): Presented {
  return {
    ...view,
    this_step: thisStep,
    steps: view.steps.map((step) => ({
      ...step,
      last_attempt: step.last_attempt === null ? null : {
        ...step.last_attempt,
        verification: step.last_attempt.verification === null ? null : {
          ...step.last_attempt.verification,
          detail: redact(step.last_attempt.verification.detail, env).slice(0, DETAIL_LIMIT),
        },
      },
      tails: tails.get(step.id) ?? null,
    })),
  };
}

const GLYPH: Record<StepView['state'], string> = {
  pending: '○', runnable: '○', running: '↻', backoff: '↻', waiting: '⏸', needs_human: '⏸', done: '✓',
};

/** Agent-authored names cannot inject terminal control sequences (progress.ts). */
function safe(name: string): string {
  return name.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function instant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function renderText(view: Presented, partial: string[], wantTails: boolean): string[] {
  const lines: string[] = [];
  const spend = `${thousands(view.spend.tokens_in)} in / ${thousands(view.spend.tokens_out)} out / $${view.spend.dollars}`
    + (view.spend.dollars_unmetered ? ' (unmetered)' : '');
  const finished = view.completion_reason === null ? '' : `   finished ${view.completion_reason}`;
  lines.push(`RUN ${view.run_id}   ${safe(view.name)}   ${view.status}   started ${formatDuration(view.now_ms - view.spawned_at_ms)} ago${finished}   spend ${spend}`);
  const counts = (['done', 'running', 'pending', 'backoff', 'waiting', 'needs_human'] as const)
    .filter((key) => view.counts[key] > 0).map((key) => `${view.counts[key]} ${key}`);
  // The denominator is always printed, even for zero steps, so a reader can
  // tell "nothing to show" from "nothing was read".
  lines.push(`steps ${view.counts.total}${counts.length === 0 ? '' : `: ${counts.join(' · ')}`}`);
  if (partial.length > 0) lines.push(`partial: ${partial.join(', ')}`);
  lines.push('');
  const idWidth = Math.max(4, ...view.steps.map((step) => Math.min(24, step.id.length)));
  for (const step of view.steps) lines.push(...renderStep(step, view, idWidth, wantTails));
  return lines;
}

function renderStep(step: PresentedStep, view: Presented, idWidth: number, wantTails: boolean): string[] {
  const failed = step.state === 'done' && step.last_attempt?.completion_reason !== 'success';
  const glyph = failed ? '✗' : GLYPH[step.state];
  const cells = [safe(step.id).slice(0, 24).padEnd(idWidth), step.type.padEnd(13), step.state.padEnd(11)];
  const iterations = step.max_iterations === null ? '' : `/${step.max_iterations}`;
  if (step.state === 'done') cells.push(`${step.attempt} attempt${step.attempt === 1 ? '' : 's'}`);
  else if (step.attempt > 0) cells.push(`attempt ${step.attempt}${iterations}`);
  if (step.elapsed_ms !== null) cells.push(formatDuration(step.elapsed_ms));
  if (step.state === 'running' && step.lease !== null) {
    cells.push(step.lease.overdue_ms > 0
      ? `LEASE OVERDUE by ${formatDuration(step.lease.overdue_ms)}`
      : `lease ok (expires in ${formatDuration(step.lease.deadline_ms - view.now_ms)})`);
  }
  if (step.state === 'backoff' && step.backoff_until_ms !== null) cells.push(`backoff until ${instant(step.backoff_until_ms)}`);
  if (step.wait !== null) cells.push(`awaiting ${step.wait.kind}: ${safe(step.wait.wait_id)}`);
  if (step.state === 'done' && step.last_attempt !== null) {
    cells.push(step.last_attempt.completion_reason);
    if (step.last_attempt.verification !== null) cells.push(`gate: ${step.last_attempt.verification.gate} ${step.last_attempt.verification.verdict}`);
  }
  if (step.id === view.this_step) cells.push('← this step');
  const lines = [`  ${glyph} ${cells.join('  ')}`.trimEnd()];

  const last = step.last_attempt;
  if (last !== null && step.state !== 'done') {
    lines.push(`      last attempt ${last.attempt}: ${last.completion_reason} → ${last.disposition}`);
  }
  if (last?.verification !== null && last?.verification !== undefined && last.verification.verdict !== 'pass') {
    lines.push(`        gate: ${last.verification.gate} ${last.verification.verdict.toUpperCase()} — ${JSON.stringify(last.verification.detail)}`);
  }
  if (step.type === 'agent' && last !== null) {
    const shown = step.artifacts.paths.slice(0, 10).map(safe).join(', ');
    const more = step.artifacts.paths.length > 10 ? ` +${step.artifacts.paths.length - 10} more` : '';
    lines.push(`      artifacts (attempt ${last.attempt}): ${step.artifacts.journaled
      ? step.artifacts.paths.length === 0 ? 'none' : `${shown}${more}`
      : 'none journaled (output was a JSON object)'}`);
  }
  if (wantTails && step.type === 'agent' && step.attempt > 0) {
    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = step.tails?.[stream] ?? null;
      if (tail === null) {
        lines.push(`      ${stream} tail: no transcript on disk for attempt ${step.attempt}`);
        continue;
      }
      lines.push(`      ${stream} tail (attempt ${tail.attempt}, last ${tail.lines.length} of ${tail.bytes} bytes):`);
      for (const line of tail.lines) lines.push(`        ${safe(line)}`);
    }
  }
  return lines;
}
