import { flow, type Ctx } from '@relayflows/surface';
import { babysitConfigured } from './babysitter.flow.ts';
import { parseInput, record, shaValid } from './input.ts';
import { subscriptions } from './subscriptions.ts';
import type { Wake } from './wake.ts';

/**
 * Cloud listeners launch the default body with a normalized event descriptor,
 * not a raw webhook. Policy is captured in the deployed source, outside that
 * input. The descriptor identifies a wake; only the shared body's subsequent
 * GitHub reread supplies state, verdicts and the head to act on.
 */
export function createHostedBabysitter(policy: unknown) {
  if (record(policy).event !== undefined) throw new Error('Hosted operator policy must not contain an event');
  const configured = parseInput(policy);
  const body = async (f: Ctx, value: unknown): Promise<void> => {
    const input = record(value), pr = record(input.pullRequest), event = record(input.event);
    if (event.provider !== 'github'
      || (pr.host !== undefined && pr.host !== 'github')
      || typeof pr.owner !== 'string' || pr.owner.toLowerCase() !== configured.owner.toLowerCase()
      || typeof pr.repo !== 'string' || pr.repo.toLowerCase() !== configured.repo.toLowerCase()
      || pr.number !== configured.number) {
      throw new Error('Hosted event does not identify the operator-pinned GitHub PR');
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
    await babysitConfigured(f, configured, wake, event.deliveryId);
  };
  return subscriptions.reduce<ReturnType<typeof flow>>(
    (handle, subscription) => handle.on(subscription.trigger, body),
    flow<unknown>('Babysitter', { budget: { dollars: 8, wallclock: '45m' } }, body),
  );
}
