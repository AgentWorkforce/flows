import { AuthoredFlowExecutionError, type AuthoredHumanWait } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
import { shellWord } from './shell-word.js';

/**
 * The answer contract for a parked `f.human`.
 *
 * The CLIENT sends `{ answer, note?, answeredBy }` as the `payload` of the
 * `event.emit` that closes the wait (kernel DESIGN.md §5: `event_key` is the
 * `wait_id`); `answeredBy` is required — the kernel refuses an unattributed
 * answer. The KERNEL journals it as the `result` of
 * `wait.completed{human_responded}` with two fields of its own: `at_ms`, the
 * entry's clock (any client `at` is dropped — the journal says when), and
 * `attribution: "client_asserted"`, because the daemon socket, not the kernel,
 * is what authenticated whoever said `answeredBy`. `flows answer` and Cloud's
 * resumed sandbox both produce the client half; the body reads the kernel half.
 */
export interface HumanAnswer {
  readonly answer: boolean;
  readonly note?: string;
  readonly answeredBy: string;
  /** Kernel clock at the journaled `wait.completed`, epoch milliseconds. */
  readonly atMs?: number;
  /** How `answeredBy` was established. The kernel writes `client_asserted`. */
  readonly attribution?: string;
}

export type HumanAnswerPayload = Pick<HumanAnswer, 'answer' | 'note' | 'answeredBy'>;

/** An open `wait.human` on a run: asked, not yet answered. */
export interface OpenHumanWait extends AuthoredHumanWait {
  readonly stepId: string;
  readonly attempt: number;
}

export const HUMAN_WAIT_ID = /^human-[1-9][0-9]*$/;

export function humanAnswerPayload(answer: boolean, extra: { note?: string; answeredBy: string }): HumanAnswerPayload {
  if (extra.answeredBy.trim() === '') {
    throw new AuthoredFlowExecutionError('human_answer_invalid', 'an answer must say who gave it (answeredBy)');
  }
  return {
    answer,
    ...(extra.note === undefined || extra.note === '' ? {} : { note: extra.note }),
    answeredBy: extra.answeredBy,
  };
}

/** Narrow an untrusted journal `result` to the answer contract, or refuse it. */
export function parseHumanAnswer(value: unknown, waitId: string): HumanAnswer {
  const record = value as { answer?: unknown; note?: unknown; answeredBy?: unknown; at_ms?: unknown; attribution?: unknown } | null;
  if (typeof record !== 'object' || record === null || typeof record.answer !== 'boolean'
    || (record.note !== undefined && typeof record.note !== 'string')
    || typeof record.answeredBy !== 'string' || record.answeredBy.trim() === ''
    || (record.at_ms !== undefined && !Number.isSafeInteger(record.at_ms))
    || (record.attribution !== undefined && typeof record.attribution !== 'string')) {
    throw new AuthoredFlowExecutionError(
      'human_answer_invalid',
      `the recorded answer to ${waitId} is not { answer: boolean, answeredBy: string }; answer it again with flows answer`,
    );
  }
  return {
    answer: record.answer,
    ...(record.note === undefined ? {} : { note: record.note }),
    answeredBy: record.answeredBy,
    ...(record.at_ms === undefined ? {} : { atMs: record.at_ms as number }),
    ...(record.attribution === undefined ? {} : { attribution: record.attribution }),
  };
}

interface WaitEntry {
  entry_type?: string;
  step_id?: string | null;
  attempt?: number | null;
  payload?: {
    wait_id?: unknown; prompt?: unknown; requested_of?: unknown;
    completionReason?: unknown; result?: unknown;
  };
}

async function readWaitEntries(journal: JournalClient, runId: string): Promise<WaitEntry[]> {
  const waits: WaitEntry[] = [];
  let fromSeq = 1;
  for (;;) {
    const page = (await journal.journalRead(runId, fromSeq, 1000)).entries as Array<WaitEntry & { seq?: number }>;
    if (page.length === 0) break;
    for (const entry of page) {
      if (typeof entry.seq !== 'number' || entry.seq < fromSeq) {
        throw new AuthoredFlowExecutionError('journal_protocol_violation', `journal.read for ${runId} returned out-of-order entries`);
      }
      fromSeq = entry.seq + 1;
      if (entry.entry_type === 'wait.human' || entry.entry_type === 'wait.completed') waits.push(entry);
    }
  }
  return waits;
}

/**
 * The recorded answer to `waitId`, or `undefined` while the question is open
 * or not yet asked. The first `human_responded` completion wins: the kernel
 * closes a wait once, so a second answer never reaches the journal.
 */
export async function readHumanAnswer(
  journal: JournalClient,
  runId: string,
  waitId: string,
): Promise<HumanAnswer | undefined> {
  for (const entry of await readWaitEntries(journal, runId)) {
    if (entry.entry_type === 'wait.completed' && entry.payload?.wait_id === waitId
      && entry.payload.completionReason === 'human_responded') {
      return parseHumanAnswer(entry.payload.result, waitId);
    }
  }
  return undefined;
}

/** Every `wait.human` on the run that no `wait.completed` has closed. */
export async function readOpenHumanWaits(journal: JournalClient, runId: string): Promise<OpenHumanWait[]> {
  const open = new Map<string, OpenHumanWait>();
  for (const entry of await readWaitEntries(journal, runId)) {
    const waitId = entry.payload?.wait_id;
    if (typeof waitId !== 'string') continue;
    if (entry.entry_type === 'wait.human') {
      open.set(waitId, {
        waitId,
        question: typeof entry.payload?.prompt === 'string' ? entry.payload.prompt : '',
        to: typeof entry.payload?.requested_of === 'string' ? entry.payload.requested_of : '',
        stepId: typeof entry.step_id === 'string' ? entry.step_id : '',
        attempt: typeof entry.attempt === 'number' ? entry.attempt : 0,
      });
    } else {
      open.delete(waitId);
    }
  }
  return [...open.values()];
}

/** How to answer a parked question from a shell, with the run's own data dir. */
export function answerCommand(runId: string, waitId: string, dataDir?: string): string {
  const dir = dataDir === undefined ? '' : ` --data-dir ${shellWord(dataDir)}`;
  return `flows answer${dir} ${runId} ${waitId} yes|no`;
}

export function resumeCommand(runId: string, dataDir?: string, localAgent = false): string {
  const dir = dataDir === undefined ? '' : ` --data-dir ${shellWord(dataDir)}`;
  return `flows resume${dir}${localAgent ? ' --local-agent' : ''} ${runId}`;
}
