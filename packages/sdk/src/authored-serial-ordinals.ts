import { AuthoredFlowExecutionError } from './authored-flow-error.js';

/**
 * Serial step ids are `<kind>-<N>`, with ONE ordinal counter shared by every
 * kind and assigned in call order (authored-flow-executor `nextId`). Inside a
 * `Promise.all` that call order follows result arrival: each branch's next
 * call is made when its previous step resolves. A resume replays completed
 * results from the journal, in whatever order they come back, so two
 * branches can take each other's ordinals.
 *
 * The kernel catches part of that: an admission key is bound to its spec, so
 * `run-3` re-requested with a different command is `run_admission_conflict`.
 * It cannot catch a KIND swap. `run-3` and `llm-3` are different admission
 * keys, so a resumed `f.run` that lands on the ordinal an `llm` already
 * holds gets a fresh key and runs again, exiting 0. This guard refuses that
 * from the root's journaled step index before the step is admitted.
 *
 * The root driver reads the index once per re-dispatched attempt
 * (authored-root.ts); a first attempt reads nothing. Nothing is journaled, so
 * first runs and in-order resumes write exactly what they wrote before. The
 * guard sees what the index holds — every `f.llm`/`f.agent` from admission,
 * other steps from completion — so an ordinal whose only holder was still in
 * flight at the crash is invisible to it. Stable per-branch identities (a new
 * identity version) remove the class.
 */
export type SerialOrdinals = ReadonlyMap<number, { readonly kind: string; readonly step: string }>;

const SERIAL_ID = /^(.+)-([1-9][0-9]*)$/u;

/**
 * The ordinals journaled directly under `prefix` (a dispatched child's
 * `dispatch-N--`, or '' for the root body). Deeper descendants, lowered
 * `.gate` steps and anything not shaped `<kind>-<N>` are not this body's.
 */
export function serialOrdinals(journaledSteps: readonly string[], prefix: string): SerialOrdinals {
  const ordinals = new Map<number, { kind: string; step: string }>();
  for (const step of journaledSteps) {
    if (!step.startsWith(prefix)) continue;
    const local = step.slice(prefix.length);
    if (local.includes('--')) continue;
    const match = SERIAL_ID.exec(local);
    if (match === null) continue;
    const ordinal = Number(match[2]);
    if (!Number.isSafeInteger(ordinal)) continue;
    ordinals.set(ordinal, { kind: match[1]!, step });
  }
  return ordinals;
}

/** Refuse `<kind>-<ordinal>` when the journal holds that ordinal under another kind. */
export function assertSerialOrdinal(ordinals: SerialOrdinals, kind: string, ordinal: number): void {
  const journaled = ordinals.get(ordinal);
  if (journaled === undefined || journaled.kind === kind) return;
  throw serialReplayOrderMismatch(
    `ordinal ${ordinal} is journaled as ${kindName(journaled.kind)} step "${journaled.step}", `
      + `but this resume reached it with ${kindName(kind)}`,
  );
}

export function serialReplayOrderMismatch(detail: string): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError(
    'serial_replay_order_mismatch',
    `serial replay order mismatch: ${detail}. Concurrent branches resolved in a different order `
      + 'than the journaled run, so the step was refused instead of executed.',
  );
}

/** Helper ids embed the root run id (`slack-<root>-N`); name the provider only. */
function kindName(kind: string): string {
  return kind.replace(/-[0-9A-HJKMNP-TV-Z]{26}$/u, '');
}
