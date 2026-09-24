// Project an authored flow's own verdict out of its root journal.
//
// `foldRunState` answers what the KERNEL recorded: the root step succeeded, so
// the run completed with `success`. That is true and must stay printed. It is
// also not what a reader asking "why did this fail?" needs when the body
// declared `step_failed` — a verdict the kernel's vocabulary cannot express on
// a step that succeeded, so it travels as output on the root's own
// `step.completed`.
//
// This is a separate, narrow projection rather than a branch inside the fold:
// the fold is generic over every run and has no business knowing what an
// authored root is, and the executor this vocabulary comes from must not
// become a dependency of `flows status`.

import {
  isDurableCompletionDetail,
  isLoweredCompletion,
  type LoweredCompletionReason,
} from './authored-completion.js';
import type { JournalEvent } from './journal-reader.js';

/** The `instruction` discriminator `authored-root.ts` writes into the root step. */
export const AUTHORED_ROOT_KIND = 'relayflows.authored-root.v1';

export interface AuthoredVerdict {
  readonly reason: LoweredCompletionReason;
  /** Absent when the body called `done()` with one argument, as most do. */
  readonly detail?: string;
}

/**
 * The verdict an authored root attested, or `null` when this journal holds none.
 *
 * `null` is the answer for an ordinary run, for an authored run still in
 * flight, and for one whose root output is malformed. The last of those
 * matters: an ordinary flow may name a step `authored-root`, and a worker may
 * journal anything into a step's output, so the step id alone attests nothing.
 * A verdict is reported only when the run's own spec declares the authored
 * root — carrying {@link AUTHORED_ROOT_KIND} metadata — and the root's last
 * `step.completed` is a terminal kernel `success` whose output is a complete,
 * in-bounds authored result. A retry or park completion is not terminal and a
 * later attempt may still change the answer, so neither is promoted.
 *
 * This is a projection for a read-only view, so a malformed record yields no
 * verdict rather than an error: refusing to render a whole status because one
 * output field is the wrong type would replace the answer with a worse one.
 */
export function authoredVerdictOf(events: readonly JournalEvent[]): AuthoredVerdict | null {
  const spawned = events[0];
  if (spawned === undefined || spawned.entry_type !== 'run.spawned') return null;
  if (!declaresAuthoredRoot(spawned)) return null;

  const completed = [...events].reverse().find((event) =>
    event.entry_type === 'step.completed' && event.step_id === 'authored-root');
  const payload = record(completed?.payload);
  if (payload === null || payload['completionReason'] !== 'success') return null;
  const disposition = payload['disposition'];
  if (disposition !== undefined && disposition !== 'step_done') return null;

  const output = record(payload['output']);
  if (output === null || typeof output['name'] !== 'string') return null;
  const reason = output['completionReason'];
  if (!isLoweredCompletion(reason)) return null;
  const detail = output['completionDetail'];
  if (detail !== undefined && !isDurableCompletionDetail(detail)) return null;

  return Object.freeze({ reason, ...(detail === undefined ? {} : { detail }) });
}

function declaresAuthoredRoot(spawned: JournalEvent): boolean {
  const spec = record(record(spawned.payload)?.['spec']);
  const steps = spec?.['steps'];
  if (!Array.isArray(steps)) return false;
  const step = record(steps[0]);
  if (step === null || step['id'] !== 'authored-root') return false;
  if (typeof step['instruction'] !== 'string') return false;
  try {
    return record(JSON.parse(step['instruction']))?.['kind'] === AUTHORED_ROOT_KIND;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
