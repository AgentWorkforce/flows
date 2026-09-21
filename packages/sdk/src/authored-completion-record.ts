// The authored verdict, written to the root BEFORE the marker is admitted.
//
// The terminal marker's command embeds the detail, and the marker run is
// opened under a stable admission key (`authored-child:<hash(root, step)>`).
// Those two facts together mean the detail has to be a durable decision, not a
// recomputed one: normalization redacts against `process.env`, so a credential
// rotated or removed while this process was down makes the SAME authored
// sentence normalize differently. A body resumed into that environment would
// retry the marker's admission key with a drifted spec, and the kernel refuses
// that as `run_admission_conflict` — losing an explanation the root had
// already journaled, for a flow whose every step succeeded.
//
// So the verdict is appended to a stream on the root run before the marker run
// is opened, and a later attempt reaching the same terminal step reuses what
// is recorded. That is exactly the durability the executor already gives a
// predicate gate (`applyPredicateGate`): record the decision first, so the
// spec built from it is identical on every attempt and author code is never
// asked the question twice.
//
// Nothing is recorded for a `done()` with no detail. Without one the marker
// command is a function of the reason alone — no environment, no drift, and
// nothing to recover — so a flow that does not opt in writes exactly the
// journal it has always written.

import {
  isDurableCompletionDetail,
  isLoweredCompletion,
  type LoweredCompletionReason,
} from './authored-completion.js';
import type { JournalClient } from './journal-client.js';

export const AUTHORED_VERDICT_STREAM = 'authored-verdict';

/** Versioned so a reader can tell this record from a future one. */
const RECORD_KIND = 'relayflows.authored-verdict.v1';

export interface AuthoredVerdictRecord {
  readonly reason: LoweredCompletionReason;
  /** Recorded only when the body passed one; see the module comment. */
  readonly detail?: string;
}

/**
 * Commit this body's verdict, or recover the one this root already committed.
 *
 * Returns the verdict the marker must be built from — the recorded one when
 * the root holds it, this attempt's otherwise. With no root run there is
 * nothing durable to write to (the non-durable executor seam) and with no
 * detail there is nothing that can drift, so both pass straight through
 * without a round trip.
 */
export async function commitAuthoredVerdict(
  journal: JournalClient,
  rootRunId: string | undefined,
  step: string,
  verdict: AuthoredVerdictRecord,
): Promise<AuthoredVerdictRecord> {
  if (rootRunId === undefined || verdict.detail === undefined) return verdict;
  const committed = await readAuthoredVerdict(journal, rootRunId, step);
  if (committed !== undefined) return committed;
  await journal.streamAppend(rootRunId, AUTHORED_VERDICT_STREAM, {
    verdict: RECORD_KIND, step, reason: verdict.reason, detail: verdict.detail,
  });
  return verdict;
}

/**
 * The verdict this root recorded for `step`, or `undefined`.
 *
 * The FIRST valid record wins: it is the one the marker was — or was about to
 * be — admitted from, and a later attempt's differently-redacted text must not
 * displace it. Records this version does not recognise, and details that fail
 * the durable check every other read boundary applies, are skipped rather than
 * trusted; the marker then drifts and the kernel refuses it loudly, which is
 * the right outcome for a record this process cannot read.
 */
export async function readAuthoredVerdict(
  journal: JournalClient,
  rootRunId: string,
  step: string,
): Promise<AuthoredVerdictRecord | undefined> {
  let offset = 0;
  for (;;) {
    const page = await journal.streamRead(rootRunId, AUTHORED_VERDICT_STREAM, offset, 1000);
    for (const message of page.messages) {
      // `stream.read` returns either the envelope or the bare message,
      // matching how the executor reads predicate verdicts.
      const raw = (message as { message?: unknown }).message ?? message;
      if (isVerdictRecord(raw) && raw.step === step) {
        return Object.freeze({ reason: raw.reason, detail: raw.detail });
      }
    }
    if (page.messages.length === 0 || page.next_offset <= offset) break;
    offset = page.next_offset;
  }
  return undefined;
}

interface StoredVerdict {
  readonly verdict: typeof RECORD_KIND;
  readonly step: string;
  readonly reason: LoweredCompletionReason;
  readonly detail: string;
}

function isVerdictRecord(value: unknown): value is StoredVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<StoredVerdict>;
  return record.verdict === RECORD_KIND
    && typeof record.step === 'string' && record.step.length > 0
    && isLoweredCompletion(record.reason)
    && isDurableCompletionDetail(record.detail);
}
