import { record, shaValid } from './input.ts';
import { subscriptions } from './subscriptions.ts';
import type { Wake } from './wake.ts';

export interface BoundPullRequest { owner: string; repo: string; number: number }

/**
 * Admit one Cloud-normalized delivery for exactly the bound PR.
 *
 * Cloud launches the default body with an event descriptor, not a raw webhook.
 * Routing is enforced here — another provider, host, repository, PR or an
 * undeclared subscription is misrouted and throws before any effect. Content
 * is not: the delivered head survives only as an advisory hint, and every
 * decision is made later from the live reread.
 */
export function admitDelivery(value: unknown, bound: BoundPullRequest): { wake: Wake; deliveryId: string } {
  const input = record(value), pr = record(input.pullRequest), event = record(input.event);
  if (event.provider !== 'github'
    || (pr.host !== undefined && pr.host !== 'github')
    || typeof pr.owner !== 'string' || pr.owner.toLowerCase() !== bound.owner.toLowerCase()
    || typeof pr.repo !== 'string' || pr.repo.toLowerCase() !== bound.repo.toLowerCase()
    || pr.number !== bound.number) {
    throw new Error('Hosted event does not identify the bound GitHub PR');
  }
  const subscription = subscriptions.find(s => s.id === event.eventType);
  if (!subscription) throw new Error('Hosted event is not a declared Babysitter subscription');
  if (typeof event.deliveryId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(event.deliveryId)) {
    throw new Error('Hosted event must carry a valid delivery id');
  }
  const wake: Wake = {
    id: subscription.id, family: subscription.family, action: subscription.action,
    // Cloud's enrichment is also a hint. It may already be stale by the
    // time the run starts, and it can never become an operator head pin.
    ...(shaValid(pr.headSha) ? { hintedSha: pr.headSha } : {}),
  };
  return { wake, deliveryId: event.deliveryId };
}
