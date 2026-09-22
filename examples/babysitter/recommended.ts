import { flow, type Ctx } from '@relayflows/surface';
import { babysitConfigured } from './babysitter.flow.ts';
import { parseInput, record, shaValid } from './input.ts';
import { subscriptions } from './subscriptions.ts';
import type { Wake } from './wake.ts';

const BOT_LOGIN = 'agent-relay[bot]';

/**
 * Input supplied by Cloud after it has matched a repository-scoped pull-request
 * delivery and reread the pull request. The delivery is still only a wake hint:
 * Babysitter immediately performs its own authoritative state read.
 */
export async function recommendedBabysitterBody(f: Ctx, value: unknown): Promise<void> {
  const input = record(value);
  const pullRequest = record(input.pullRequest);
  const event = record(input.event);
  const approver = typeof input.approver === 'string' ? input.approver.trim() : '';
  if (!approver
    || event.provider !== 'github'
    || pullRequest.host !== undefined
    || typeof pullRequest.owner !== 'string'
    || typeof pullRequest.repo !== 'string'
    || !Number.isSafeInteger(pullRequest.number)
    || Number(pullRequest.number) <= 0) {
    throw new Error('Recommended Babysitter requires a normalized GitHub pull request and approver');
  }
  const subscription = subscriptions.find(candidate => candidate.id === event.eventType);
  if (!subscription) throw new Error('Recommended Babysitter received an undeclared subscription');
  if (typeof event.deliveryId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(event.deliveryId)) {
    throw new Error('Recommended Babysitter requires a valid delivery id');
  }

  // Policy is authored here, not accepted from PR content or the delivery.
  // Automatic merge remains off. Review/fix publication also remains held by
  // the capability gates in babysitConfigured until the platform proves them.
  const configured = parseInput({
    owner: pullRequest.owner,
    repo: pullRequest.repo,
    number: pullRequest.number,
    // The recommended activation does not yet collect repository validation
    // policy. Keep validation closed even if the write-scope capability is
    // later unlocked; a no-op command must never stand in for project tests.
    testCommand: 'false',
    botLogin: BOT_LOGIN,
    approvers: [approver],
    organizations: [],
    merge: false,
    reviewAuthors: [],
    skipLabels: ['no-agent-relay-review'],
    requiredChecks: [],
  });
  const wake: Wake = {
    id: subscription.id,
    family: subscription.family,
    action: subscription.action,
    ...(shaValid(pullRequest.headSha) ? { hintedSha: pullRequest.headSha } : {}),
  };
  await babysitConfigured(f, configured, wake, event.deliveryId);
}

export default flow<unknown>('babysitter', {
  version: '1.0.0',
  budget: { dollars: 8, wallclock: '45m' },
}, recommendedBabysitterBody);
