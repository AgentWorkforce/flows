import { github, type TriggerSource } from '@relayflows/surface';

/**
 * The resident wake contract, declared once.
 *
 * Every entry is a **hint that something may have changed** — never a fact the
 * flow acts on. `babysit` rereads authoritative live state on each wake and
 * binds its action to the live head SHA (see `wake.ts`), so a subscription
 * decides only *whether to look*, never *what is true*.
 *
 * This list is the single source of the flow's `.on(...)` registrations, of
 * `parseInput`'s accepted event families, and of the liveness sweep's expected
 * set. Declaring a handler the input validator does not accept — or sweeping a
 * subscription nothing registers — is impossible by construction.
 */
export const families = ['pull_request', 'pull_request_review', 'check_run', 'issue_comment'] as const;
export type Family = typeof families[number];

export interface Subscription {
  /** `<family>.<action>`; stable across deliveries and used as the sweep key. */
  readonly id: string;
  readonly family: Family;
  readonly action: string;
  readonly purpose: 'lifecycle' | 'review' | 'checks' | 'policy' | 'repair';
  /** Why the resident needs this wake. Read by humans, asserted by tests. */
  readonly why: string;
  readonly trigger: TriggerSource;
}

function entry(family: Family, action: string, purpose: Subscription['purpose'], why: string, trigger: TriggerSource): Subscription {
  return Object.freeze({ id: `${family}.${action}`, family, action, purpose, why, trigger });
}

// The generic `github.<family>(...)` forms keep one filter shape across the
// whole contract — `{ provider, type: <family>, payload: { action } }` — so the
// dotted convenience helpers (which mint a distinct `type`) are deliberately
// unused. `ready_for_review`, `labeled` and `unlabeled` have no dotted helper
// at all, and a contract that mixed both shapes could not be checked uniformly.
export const subscriptions: readonly Subscription[] = Object.freeze([
  entry('pull_request', 'opened', 'lifecycle', 'A new PR may be in scope', github.pull_request('opened')),
  entry('pull_request', 'synchronize', 'lifecycle', 'A new head invalidates every verdict bound to the old one', github.pull_request('synchronize')),
  entry('pull_request', 'reopened', 'lifecycle', 'A PR previously out of scope is back in it', github.pull_request('reopened')),
  entry('pull_request', 'ready_for_review', 'lifecycle', 'A draft left draft state', github.pull_request('ready_for_review')),
  entry('pull_request', 'closed', 'lifecycle', 'Stop working a PR that live state will confirm is closed or merged', github.pull_request('closed')),
  entry('pull_request', 'labeled', 'policy', 'A skip or merge-policy label may now apply', github.pull_request('labeled')),
  entry('pull_request', 'unlabeled', 'policy', 'A skip or merge-policy label may have been withdrawn', github.pull_request('unlabeled')),
  entry('pull_request_review', 'submitted', 'review', 'An approval or change request may move the merge gate', github.pull_request_review({ action: 'submitted' })),
  entry('pull_request_review', 'dismissed', 'review', 'A dismissal can withdraw the approval a merge gate rested on', github.pull_request_review({ action: 'dismissed' })),
  entry('check_run', 'completed', 'checks', 'CI reached a conclusion the merge gate reads', github.check_run('completed')),
  entry('issue_comment', 'created', 'repair', 'An explicit, authorized conflict-repair directive may have arrived', github.issue_comment('created')),
]);

export const subscriptionIds: readonly string[] = Object.freeze(subscriptions.map(s => s.id));

const byKey = new Map(subscriptions.map(s => [s.id, s]));

/** The declared subscription an (family, action) pair belongs to, if any. */
export function subscriptionFor(family: string, action: string): Subscription | undefined {
  return byKey.get(`${family}.${action}`);
}

/** Actions this flow accepts for a family. Unlisted actions are refused at input. */
export function actionsFor(family: Family): readonly string[] {
  return subscriptions.filter(s => s.family === family).map(s => s.action);
}

/** The webhook inboxes the contract needs registered in `flows.json`. */
export const requiredExecutors: readonly string[] = Object.freeze([
  ...new Set(subscriptions.map(s => s.trigger.name)),
]);
