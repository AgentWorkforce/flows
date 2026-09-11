import { providerEventTypes, webhook, type TriggerSource, type WebhookFilter } from '@relayflows/surface';
import type { TriggerSpec } from './spec.js';

/** Lower a surface subscription to the existing inbox executor contract. */
export function webhookTriggerSpec(id: string, source: TriggerSource): TriggerSpec {
  if (source.kind !== 'webhook') throw new TypeError('unsupported trigger kind');
  const trigger = webhook(source.name, source.filter);
  return {
    id,
    executor: trigger.name,
    eventType: trigger.name,
    ...(trigger.filter === undefined ? {} : { pattern: trigger.filter }),
    // The inbox watcher supplies the durable file ID as the event key.
    dedupeKeyTemplate: '{{event.type}}',
  };
}

/** Provider ingress uses the path as authority; it never trusts a body to reroute. */
export function providerInboxEvent(provider: string, value: unknown): WebhookFilter {
  if (!Object.hasOwn(providerEventTypes, provider)) throw new TypeError(`unknown provider: ${provider}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('provider event must be an object');
  }
  const event = value as Record<string, unknown>;
  const types: readonly string[] = providerEventTypes[provider as keyof typeof providerEventTypes];
  if (typeof event.type !== 'string' || !types.includes(event.type)) {
    throw new TypeError(`unknown event type for ${provider}`);
  }
  if (event.provider !== undefined && event.provider !== provider) throw new TypeError('provider does not match inbox');
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new TypeError('provider event payload must be an object');
  }
  return webhook(provider, { ...event, provider } as WebhookFilter).filter!;
}
