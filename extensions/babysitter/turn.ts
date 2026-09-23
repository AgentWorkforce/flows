/**
 * The native Babysitter turn contract: Cloud's normalized delivery descriptor
 * in, one `cloud:babysitter-turn` queue request out.
 *
 * Nothing here is authority. The delivery is an envelope: Cloud's capability
 * adapter checks it against the host-verified dispatch, loads the persisted
 * activation, rereads the live PR (open, exact `babysit` label, head), and
 * resolves the bound session and lineage. The handler never names a session,
 * lineage, head, label, route, or config, so a forged or stale descriptor can
 * at most ask Cloud to look again.
 */

/** The subscriptions flows-plugin.json declares, as `event.action` event types. */
export const SUBSCRIPTIONS = [
  'pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened',
  'pull_request.ready_for_review', 'pull_request.closed', 'pull_request.labeled',
  'pull_request.unlabeled', 'pull_request_review.submitted', 'pull_request_review.dismissed',
  'check_run.completed', 'issue_comment.created',
] as const;
export type Subscription = (typeof SUBSCRIPTIONS)[number];

export interface BabysitterTurnDelivery {
  readonly deliveryId: string;
  readonly provider: 'github';
  readonly eventType: Subscription;
  readonly pullRequest: { readonly owner: string; readonly repository: string; readonly number: number };
}

/**
 * `queued`: Cloud wrote its head-bound receipt and Relay accepted the turn.
 * `duplicate`: that lineage and live head were already queued. Every refusal
 * and every in-doubt transport failure rejects instead of resolving.
 */
export interface BabysitterTurnReceipt {
  readonly receiptId: string;
  readonly status: 'queued' | 'duplicate';
}

const DELIVERY = /^[A-Za-z0-9_.:-]{1,200}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const RECEIPT = /^[A-Za-z0-9_.:-]{1,200}$/;

function refuse(message: string): never {
  throw new Error(`babysitter: ${message}`);
}

function record(value: unknown, what: string, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse(`${what} must be an object.`);
  const object = value as Record<string, unknown>;
  const extra = Object.keys(object).filter(key => !keys.includes(key));
  if (extra.length > 0) refuse(`${what} has unexpected fields ${extra.join(', ')}.`);
  const missing = required.filter(key => !Object.hasOwn(object, key));
  if (missing.length > 0) refuse(`${what} is missing ${missing.join(', ')}.`);
  return object;
}

function matches(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) refuse(`${what} is malformed.`);
  return value;
}

/**
 * Validate the descriptor a handler received against the subscription that
 * handler was registered for. Any drift, unknown field, or raw webhook shape
 * is refused rather than guessed at. Cloud's `headSha` enrichment is checked
 * but not forwarded: Cloud binds to the head it rereads, never to a hint.
 */
export function turnDelivery(subscription: Subscription, input: unknown): BabysitterTurnDelivery {
  const top = record(input, 'input', ['event', 'pullRequest'], ['event', 'pullRequest']);
  const event = record(top.event, 'event', ['provider', 'eventType', 'deliveryId'], ['provider', 'eventType', 'deliveryId']);
  const pr = record(top.pullRequest, 'pullRequest', ['host', 'owner', 'repo', 'number', 'headSha'], ['owner', 'repo', 'number']);
  if (event.provider !== 'github') refuse('event.provider must be github.');
  if (event.eventType !== subscription) refuse(`event ${JSON.stringify(event.eventType)} was delivered to the ${subscription} handler.`);
  if (pr.host !== undefined && pr.host !== 'github') refuse('pullRequest.host must be github.');
  const owner = matches(pr.owner, OWNER, 'pullRequest.owner');
  const repository = matches(pr.repo, REPO, 'pullRequest.repo');
  if (repository === '.' || repository === '..') refuse('pullRequest.repo is malformed.');
  if (typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number <= 0) refuse('pullRequest.number must be a positive integer.');
  if (pr.headSha !== undefined) matches(pr.headSha, SHA, 'pullRequest.headSha');
  return Object.freeze({
    deliveryId: matches(event.deliveryId, DELIVERY, 'event.deliveryId'),
    provider: 'github',
    eventType: subscription,
    pullRequest: Object.freeze({ owner, repository, number: pr.number }),
  });
}

/** Cloud's answer is data from across a boundary; an unknown shape fails the run. */
export function turnReceipt(value: unknown): BabysitterTurnReceipt {
  const receipt = record(value, 'turn receipt', ['receiptId', 'status'], ['receiptId', 'status']);
  const receiptId = matches(receipt.receiptId, RECEIPT, 'turn receipt receiptId');
  if (receipt.status !== 'queued' && receipt.status !== 'duplicate') refuse('turn receipt status is unknown.');
  return Object.freeze({ receiptId, status: receipt.status });
}
