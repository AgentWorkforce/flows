// The display-only actual-cost fold beside run-state's metered spend.
// Nothing here is enforcement: the kernel charges `budget`, never `reported_cost`.

import { declaresAuthoredRoot } from './authored-verdict.js';
import { addDollars } from './decimal-dollars.js';
import { HELPER_INSTRUCTION_PREFIX } from './helper-instruction.js';
import type { JournalEvent } from './journal-reader.js';

type Payload = Record<string, unknown>;

/**
 * What steps actually cost, summed from each attempt's journaled
 * `reported_cost` (the CLI's own total, or a full-usage estimate). Display
 * only: the kernel charges `spend` against `maxDollars`, never this. `complete`
 * is false when some completed model attempt reported no cost (e.g. Codex, or
 * an older runtime), so `dollars` is then a lower bound. Segment rollover keeps
 * earlier completions in the journal, so an epoch summary does not lose any.
 */
export interface ReportedCostTotal {
  /** Decimal string. */
  dollars: string;
  complete: boolean;
  /** Where the summed figures came from; `mixed` when attempts differ. */
  source: 'cli' | 'priced' | 'mixed' | null;
}

/**
 * Steps known to run no model, read from the spawned spec. Deliberately
 * narrow: a crash-recovered or cancelled model attempt journals a default zero
 * budget although the model ran, so metering nothing proves nothing. A step
 * not listed here that reports no cost stays unknown, and the total reads as a
 * lower bound rather than a false complete figure.
 * - a deterministic step runs a command;
 * - a provider helper (`relayflows:helper:v1`) performs a relayfile write;
 * - the authored root runs the flow body, whose model calls are child runs with
 *   journals of their own. Only a spec carrying the authored-root discriminator
 *   counts: an ordinary flow may name a step `authored-root`.
 * A memoized reuse is free too, per completion (`reused_from`): the source run
 * paid for the model.
 */
export function modelFreeSteps(spawned: JournalEvent): Set<string> {
  const payload = spawned.payload !== null && typeof spawned.payload === 'object' ? spawned.payload as Payload : {};
  const spec = payload['spec'] !== null && typeof payload['spec'] === 'object' ? payload['spec'] as Payload : {};
  const steps = Array.isArray(spec['steps']) ? spec['steps'] as unknown[] : [];
  const authoredRoot = declaresAuthoredRoot(spawned);
  const free = new Set<string>();
  for (const entry of steps) {
    const step = entry !== null && typeof entry === 'object' ? entry as Payload : {};
    if (typeof step['id'] !== 'string') continue;
    const helper = step['type'] === 'agent' && typeof step['instruction'] === 'string'
      && step['instruction'].startsWith(HELPER_INSTRUCTION_PREFIX);
    if (step['type'] === 'deterministic' || helper || (authoredRoot && step['id'] === 'authored-root')) free.add(step['id']);
  }
  return free;
}

export const NO_REPORTED_COST: ReportedCostTotal = { dollars: '0', complete: true, source: null };


/**
 * Add one completed attempt's journaled `reported_cost` to a total. A model
 * attempt without one (older runtime, Codex, unpriced) leaves the sum unchanged
 * and marks it incomplete rather than counting an unknown cost as zero.
 */
export function addReportedCost(total: ReportedCostTotal, completion: Payload, modelFree: boolean): ReportedCostTotal {
  const charge = completion['reported_cost'];
  const cost = charge !== null && typeof charge === 'object' && !Array.isArray(charge) ? charge as Payload : null;
  const reused = completion['reused_from'] !== undefined && completion['reused_from'] !== null;
  if (cost === null && (modelFree || reused)) return total;
  const dollars = cost === null ? null : cost['dollars'];
  const source = cost === null ? null : cost['source'];
  // An internal effect worker ran no model: a known $0 that names no cost source.
  if (source === 'no_model') return total;
  if (typeof dollars !== 'string' || !/^\d+(?:\.\d+)?$/.test(dollars) || (source !== 'cli' && source !== 'priced')) {
    return { ...total, complete: false };
  }
  return {
    dollars: addDollars(total.dollars, dollars),
    complete: total.complete,
    source: total.source === null || total.source === source ? source : 'mixed',
  };
}
