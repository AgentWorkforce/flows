import type { JournalClient } from './journal-client.js';

/**
 * The root run's durable index of the child runs an authored body opened.
 *
 * An authored flow is not one kernel run: every `f.run`, `f.agent`, `f.llm`
 * and lowered gate is its own single-step child run with its own
 * `<dataDir>/runs/<runId>.sqlite3`. The only thing that ties a child back to
 * the root id a caller (or Cloud) knows is an index — and until now that index
 * existed only in the root's SUCCESS completion output
 * (`authored-root.ts` `driveRoot`). A failed body took
 * `terminalizeRootFailure`, which journals `{ error }` and nothing else, so a
 * failed run named no child at all. A failed run is exactly when its children
 * are worth reading.
 *
 * The completion output could not be made to carry it either: the root is
 * lowered as `type: 'agent'`, and the kernel nulls a failed agent's `output`
 * (`preserve_failure_output`, relayflowd-core/src/machine.rs), preserving only
 * a 2,000-character render in `verification.detail`. So the index is written
 * where a failure cannot erase it — appended to a stream on the ROOT run as
 * each child is opened, using the same `journal.streamAppend` durability the
 * executor already relies on for predicate verdicts.
 *
 * Each record is bounded on its own rather than the index being truncated as
 * one blob: a hundredth child must not push the first one out of the record.
 */
export const AUTHORED_STEP_STREAM = 'authored-steps';

/** Versioned so a reader can tell this record from a future one. */
const RECORD_KIND = 'relayflows.authored-step.v1';

/**
 * Per-field cap. Step ids and run ids are short by construction; the cap
 * exists so a hostile or buggy id cannot make one record unbounded.
 */
const FIELD_CHARS = 256;

/**
 * `admitted` and `completed` are kept distinct on purpose. `admitted` says
 * only "this child run exists and here is where to read it" — it never
 * carries a `completionReason`, because manufacturing one for an attempt
 * that has not completed would turn an unfinished child into a false fact.
 * `completed` is written only from a terminal `step.completed` the journal
 * actually holds.
 */
export interface AuthoredStepRecord {
  readonly index: typeof RECORD_KIND;
  readonly step: string;
  readonly runId: string;
  readonly state: 'admitted' | 'completed';
  /** Present only on `completed`. */
  readonly completionReason?: string;
  /**
   * The kernel step the completion came from, when it is not the authored
   * operation's own id. A child spec has two steps once a named gate is
   * lowered, so the terminal failure can be `<step>.verify` rather than
   * `<step>` — saying which is the difference between an index and a guess.
   */
  readonly kernelStep?: string;
}

/**
 * Append one record, or do nothing when there is no root to append to.
 *
 * The undefined-root case is the non-durable executor seam (`executeAuthoredFlow`
 * called without `rootRunId`), which has no root run and therefore nothing to
 * index. It is not a silent fallback: there is no durable place for the record
 * to go, and the caller already knows it opted out of one.
 *
 * Append failures propagate (AGENTS.md rule 4). Callers on a path that is
 * already failing must surface the persistence error ALONGSIDE the original
 * failure rather than letting it replace it — see `alsoRecord`.
 */
export async function recordAuthoredChild(
  journal: JournalClient,
  rootRunId: string | undefined,
  record: Omit<AuthoredStepRecord, 'index'>,
): Promise<void> {
  if (rootRunId === undefined) return;
  await journal.streamAppend(rootRunId, AUTHORED_STEP_STREAM, {
    index: RECORD_KIND,
    step: bound(record.step),
    runId: bound(record.runId),
    state: record.state,
    ...(record.completionReason === undefined ? {} : { completionReason: bound(record.completionReason) }),
    ...(record.kernelStep === undefined || record.kernelStep === record.step
      ? {} : { kernelStep: bound(record.kernelStep) }),
  });
}

/**
 * Record a child on a path that is already throwing, keeping both facts.
 *
 * A failed append must not be relabelled as successful collection, and it must
 * not replace the failure the caller is about to report. It returns the note
 * to append to that failure's message instead.
 */
export async function alsoRecord(
  journal: JournalClient,
  rootRunId: string | undefined,
  record: Omit<AuthoredStepRecord, 'index'>,
): Promise<string> {
  try {
    await recordAuthoredChild(journal, rootRunId, record);
    return '';
  } catch (error) {
    return `\nCould not persist the step index: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Fold the root's stream back into one record per authored step.
 *
 * A `completed` record supersedes the `admitted` one for the same step; first
 * admission order is preserved so the index reads in the order the body ran.
 * Records this version does not recognise are skipped rather than trusted.
 */
export async function readAuthoredStepIndex(
  journal: JournalClient,
  rootRunId: string,
): Promise<AuthoredStepRecord[]> {
  const index = new Map<string, AuthoredStepRecord>();
  let offset = 0;
  for (;;) {
    const page = await journal.streamRead(rootRunId, AUTHORED_STEP_STREAM, offset, 1000);
    for (const message of page.messages) {
      // `stream.read` returns either the envelope or the bare message,
      // matching how the executor reads predicate verdicts.
      const raw = (message as { message?: unknown }).message ?? message;
      if (!isAuthoredStepRecord(raw)) continue;
      const previous = index.get(raw.step);
      // An `admitted` record arriving after a `completed` one (a resumed body
      // re-admitting the same child under its stable admission key) must not
      // un-complete it.
      if (previous?.state === 'completed' && raw.state === 'admitted') continue;
      index.set(raw.step, raw);
    }
    if (page.messages.length === 0 || page.next_offset <= offset) break;
    offset = page.next_offset;
  }
  return [...index.values()];
}

function isAuthoredStepRecord(value: unknown): value is AuthoredStepRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<AuthoredStepRecord>;
  return record.index === RECORD_KIND
    && typeof record.step === 'string' && record.step.length > 0
    && typeof record.runId === 'string' && record.runId.length > 0
    && (record.state === 'admitted' || record.state === 'completed')
    && (record.completionReason === undefined || typeof record.completionReason === 'string')
    && (record.kernelStep === undefined || typeof record.kernelStep === 'string');
}

function bound(value: string): string {
  return value.length <= FIELD_CHARS ? value : `${value.slice(0, FIELD_CHARS)}…`;
}
