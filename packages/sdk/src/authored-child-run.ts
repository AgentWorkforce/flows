import { delay, LEASE_SWEEP_GRACE_MS } from './cli/run.js';
import type { JournalClient } from './journal-client.js';
import type { RunGetResult, RunStatus } from './protocol.js';

/** One `journal.read` page; the kernel caps an unbounded read at 100 entries. */
const PAGE = 1_000;
const POLL_MS = 50;
// A run between two of its own actions can report `running` with nothing in
// flight for a moment (a wait just completed, the next attempt not yet
// journaled). The same bound `classifyOutcome` gives that window (#179).
const MAX_IDLE_POLLS = 40;

/**
 * Every entry of a child run's journal, paged.
 *
 * A single unbounded read returns the first 100 entries only, and a reader
 * that needs the LAST completion of a step cannot stop at a page boundary.
 * A short page is the end of the journal.
 */
export async function readChildJournal(journal: JournalClient, runId: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let fromSeq = 1;
  while (true) {
    const { entries } = await journal.journalRead(runId, fromSeq, PAGE);
    all.push(...entries);
    if (entries.length < PAGE) return all;
    const last = entries.at(-1) as { seq?: unknown } | undefined;
    if (typeof last?.seq !== 'number' || !Number.isSafeInteger(last.seq) || last.seq < fromSeq) {
      throw new Error(`invalid journal sequence reading child run "${runId}"`);
    }
    fromSeq = last.seq + 1;
  }
}

/**
 * Wait until an authored operation's child run is terminal, and say whether
 * it got there.
 *
 * A child adopted through its admission key is not necessarily finished: on
 * `flows resume` of a root whose daemon survived, `run.start` returns the
 * existing child's CURRENT outcome without driving it, so the child may still
 * be executing an attempt, or sleeping out a retry backoff, on the request
 * that originally started it. Reading its journal then judges a history that
 * is still being written.
 *
 * The wait is read-only on purpose: it never resumes the child. The kernel
 * drives a deterministic attempt inline on the request that started it, and a
 * second driver would presume that attempt dead and run the command again.
 *
 * Bounded by the child's own journaled deadlines, never a fixed one: a running
 * attempt by its lease (renewed as the lease renews) plus the kernel's
 * lease-sweep grace, a backoff by the `sleep.until` it journaled. With nothing
 * in flight, only the short settling window above; a child parked on a worker
 * returns at once. Either way the caller gets the status and decides.
 */
export async function waitForTerminalChildRun(
  journal: JournalClient,
  runId: string,
  signal?: AbortSignal,
): Promise<RunStatus> {
  let idlePolls = 0;
  while (true) {
    if (signal?.aborted === true) throw new Error(`waiting for child run "${runId}" was canceled`);
    const snapshot = await journal.runGet(runId);
    if (snapshot.status === 'completed' || snapshot.status === 'failed') return snapshot.status;
    const inFlight = await inFlightDeadline(journal, runId, snapshot);
    if (inFlight === 'parked') return snapshot.status;
    if (inFlight !== undefined) {
      idlePolls = 0;
      const remainingMs = inFlight.deadlineMs + inFlight.graceMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`child run "${runId}" step "${inFlight.stepId}" passed its ${inFlight.what}`
          + ` (${inFlight.deadlineMs}) without reaching a terminal state`);
      }
      await delay(Math.min(POLL_MS, remainingMs), signal);
      continue;
    }
    if (idlePolls >= MAX_IDLE_POLLS) return snapshot.status;
    idlePolls += 1;
    await delay(POLL_MS, signal);
  }
}

interface InFlight {
  stepId: string;
  what: 'lease' | 'retry backoff';
  deadlineMs: number;
  graceMs: number;
}

/**
 * What the child is waiting on, and until when; `parked` when it is waiting
 * on nothing this process can wait out.
 *
 * A worker-typed (`agent`/`llm`) step that is runnable, or whose retry
 * backoff has elapsed, with no attempt running, needs a worker — or the
 * `run.resume` a caller like `classifyOutcome` issues — to move. That is the
 * park `classifyOutcome` reports, and waiting on it would only delay the same
 * answer. A deterministic step in that state is the kernel between two of its
 * own actions, which the caller's settling window covers.
 */
async function inFlightDeadline(
  journal: JournalClient,
  runId: string,
  snapshot: RunGetResult,
): Promise<InFlight | 'parked' | undefined> {
  const steps = Object.entries(snapshot.steps);
  const running = steps.find(([, step]) => step.state === 'running' && step.lease_deadline_ms !== undefined);
  if (running !== undefined) {
    return {
      stepId: running[0], what: 'lease', deadlineMs: running[1].lease_deadline_ms!, graceMs: LEASE_SWEEP_GRACE_MS,
    };
  }
  const worker = ([, step]: [string, { type: string }]) => step.type !== 'deterministic';
  if (steps.some(entry => worker(entry) && entry[1].state === 'runnable')) return 'parked';
  const backoff = steps.find(([, step]) => step.state === 'backoff');
  if (backoff === undefined) return undefined;
  const wakeAtMs = (await readChildJournal(journal, runId))
    .map(entry => retryWake(entry, backoff[0]))
    .filter((value): value is number => value !== undefined)
    .at(-1);
  if (wakeAtMs === undefined) return undefined;
  if (wakeAtMs <= Date.now()) return worker(backoff) ? 'parked' : undefined;
  return { stepId: backoff[0], what: 'retry backoff', deadlineMs: wakeAtMs, graceMs: 0 };
}

function retryWake(entry: unknown, stepId: string): number | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { entry_type: type, step_id: step, payload } = entry as Record<string, unknown>;
  if (type !== 'sleep.until' || step !== stepId || typeof payload !== 'object' || payload === null) return undefined;
  const wakeAtMs = (payload as Record<string, unknown>)['wake_at_ms'];
  return typeof wakeAtMs === 'number' && Number.isFinite(wakeAtMs) ? wakeAtMs : undefined;
}
