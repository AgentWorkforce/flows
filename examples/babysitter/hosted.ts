import { flow, type Ctx } from '@relayflows/surface';
import { babysitConfigured } from './babysitter.flow.ts';
import { admitDelivery } from './binding.ts';
import { parseInput, record } from './input.ts';
import { subscriptions } from './subscriptions.ts';

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
    const { wake, deliveryId } = admitDelivery(value, configured);
    await babysitConfigured(f, configured, wake, deliveryId);
  };
  return subscriptions.reduce<ReturnType<typeof flow>>(
    (handle, subscription) => handle.on(subscription.trigger, body),
    flow<unknown>('Babysitter', { budget: { tokens: 800_000, dollars: 8, wallclock: '45m' } }, body),
  );
}
