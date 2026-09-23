import { classify, hintedHead, shaValid, type Config } from './input.ts';
import type { State } from './state.ts';
import { subscriptionFor, type Family } from './subscriptions.ts';

/**
 * A wake is a *hint*, and this module is where that is enforced.
 *
 * Nothing here reads a decision out of a webhook payload. `classify` (in
 * `input.ts`, with the rest of the untrusted-payload readers) says only which
 * subscription delivered; `hintedHead` records what the payload claimed so a
 * stale hint is observable; `bindHead` takes the head from the live read and
 * from nowhere else. A payload that says "closed", "approved" or "green" is
 * not evidence — the live reread that follows the wake is.
 */
export interface Wake {
  /** The declared subscription id, or `operator.direct` for a run with no event. */
  readonly id: string;
  readonly family: Family | 'operator';
  readonly action: string;
  /** The head the payload claimed. Advisory: it never binds an action. */
  readonly hintedSha?: string;
}

export function wakeOf(c: Config): Wake {
  if (c.event === undefined) return Object.freeze({ id: 'operator.direct', family: 'operator', action: 'direct' });
  const { family, action } = classify(c.event);
  const hint = hintedHead(c.event, family);
  return Object.freeze({ id: `${family}.${action}`, family, action, ...(hint === undefined ? {} : { hintedSha: hint }) });
}

/**
 * Bind the run to the exact current head.
 *
 * The live read is the only authority. An operator-pinned `headSha` is a
 * *constraint*, not a source: when it no longer matches live state the run
 * declines rather than acting on the pin. A webhook's hinted head is never
 * consulted here — that is the whole point of the wake-hint contract.
 */
export function bindHead(live: State, c: Config): { head: string } | { refusal: string } {
  if (!shaValid(live.headSha)) return { refusal: 'No authoritative live head; refusing to bind an action' };
  if (c.headSha !== undefined && c.headSha !== live.headSha) {
    return { refusal: `Operator pin ${c.headSha} is no longer the live head ${live.headSha}` };
  }
  return { head: live.headSha };
}

/** How the delivered hint relates to the head actually bound. Observability only. */
export function hintStaleness(wake: Wake, head: string): 'bound' | 'stale-hint' | 'no-hint' {
  if (wake.hintedSha === undefined) return 'no-hint';
  return wake.hintedSha === head ? 'bound' : 'stale-hint';
}

/**
 * The identity of a decision, not of a delivery.
 *
 * Duplicate and out-of-order deliveries collapse here: the key names the
 * subscription and the *live* head, so two deliveries of the same event, and a
 * late event carrying an older head, all produce the same key once live state
 * is read. Nothing in it comes from the payload.
 */
export function decisionKey(c: Pick<Config, 'owner' | 'repo' | 'number'>, wake: Wake, head: string): string {
  return `babysitter:${wake.id}:${c.owner.toLowerCase()}/${c.repo.toLowerCase()}#${c.number}@${head}`;
}

/** One deterministic line per wake: what woke us, what we bound, what we ignored. */
export function observation(c: Pick<Config, 'owner' | 'repo' | 'number'>, wake: Wake, bound: { head: string } | { refusal: string }): string {
  if ('refusal' in bound) return `wake ${wake.id} hint=${wake.hintedSha ?? 'none'} bind=refused reason=${bound.refusal}`;
  return `wake ${wake.id} hint=${hintStaleness(wake, bound.head)} bind=${bound.head} key=${decisionKey(c, wake, bound.head)}`;
}

/** Whether a declared subscription wakes this body. Mirrors `parseInput`'s gate. */
export function subscribed(family: string, action: string): boolean {
  return subscriptionFor(family, action) !== undefined;
}
