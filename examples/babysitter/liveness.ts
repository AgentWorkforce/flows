import { subscriptionIds } from './subscriptions.ts';

/**
 * Trigger liveness (RFC-0001 gate 2, consumer note 4).
 *
 * "A flow that is never triggered reports nothing" is the failure this module
 * exists to make impossible to miss. A resident Babysitter that silently loses
 * its `check_run` subscription looks identical, from the outside, to a
 * repository where CI simply has not run — both produce no wakes. The sweep
 * below turns that silence into a named status.
 *
 * It is deliberately pure: wakes in, statuses out, no clock and no storage of
 * its own. `nowMs` and `sinceMs` are supplied by the caller so the sweep is
 * deterministic and the durable store can be swapped in without touching it.
 *
 * `sinceMs` is when observation began (deployment, or the start of the retained
 * window). Without it a freshly deployed subscription is indistinguishable from
 * a dead one, and a sweep that pages on every deploy gets muted, which is worse
 * than no sweep at all.
 */
export interface WakeRecord {
  readonly subscription: string;
  readonly atMs: number;
}

/** `pending` is "young enough that silence proves nothing"; `never` is not. */
export type LivenessStatus = 'live' | 'stale' | 'pending' | 'never';

export interface SubscriptionLiveness {
  readonly subscription: string;
  readonly lastWakeMs: number | null;
  readonly ageMs: number | null;
  readonly status: LivenessStatus;
}

export interface LivenessWindow {
  readonly nowMs: number;
  readonly sinceMs: number;
  readonly staleAfterMs: number;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`Liveness ${name} must be a finite number of milliseconds`);
}

/**
 * Status per declared subscription, ordered by the declaration so two sweeps of
 * the same window are byte-identical.
 */
export function liveness(wakes: readonly WakeRecord[], window: LivenessWindow, expected: readonly string[] = subscriptionIds): SubscriptionLiveness[] {
  assertFinite(window.nowMs, 'nowMs'); assertFinite(window.sinceMs, 'sinceMs'); assertFinite(window.staleAfterMs, 'staleAfterMs');
  if (window.staleAfterMs <= 0) throw new Error('Liveness staleAfterMs must be positive');
  if (window.sinceMs > window.nowMs) throw new Error('Liveness window starts after it ends');
  const last = new Map<string, number>();
  for (const wake of wakes) {
    if (typeof wake.subscription !== 'string' || !Number.isFinite(wake.atMs)) throw new Error('Malformed wake record');
    // A wake recorded ahead of `nowMs` is a clock fault, not liveness evidence.
    if (wake.atMs > window.nowMs || wake.atMs < window.sinceMs) continue;
    const prior = last.get(wake.subscription);
    if (prior === undefined || wake.atMs > prior) last.set(wake.subscription, wake.atMs);
  }
  return expected.map(subscription => {
    const lastWakeMs = last.get(subscription);
    if (lastWakeMs === undefined) {
      return { subscription, lastWakeMs: null, ageMs: null, status: window.nowMs - window.sinceMs > window.staleAfterMs ? 'never' : 'pending' };
    }
    const ageMs = window.nowMs - lastWakeMs;
    return { subscription, lastWakeMs, ageMs, status: ageMs > window.staleAfterMs ? 'stale' : 'live' };
  });
}

/** Subscriptions whose silence is now evidence of a broken trigger plane. */
export function unhealthy(report: readonly SubscriptionLiveness[]): SubscriptionLiveness[] {
  return report.filter(entry => entry.status === 'stale' || entry.status === 'never');
}

/** Deterministic text for the sweep. Same window in, same bytes out. */
export function livenessReport(report: readonly SubscriptionLiveness[]): string {
  const broken = unhealthy(report);
  return [
    `Babysitter subscription liveness: ${broken.length === 0 ? 'all declared subscriptions accounted for' : `${broken.length} of ${report.length} unaccounted for`}`,
    ...report.map(entry => `- ${entry.subscription}: ${entry.status}${entry.ageMs === null ? '' : ` (last wake ${entry.ageMs}ms ago)`}`),
  ].join('\n');
}
