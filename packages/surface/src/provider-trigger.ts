import { webhook, type TriggerSource, type WebhookFilter } from "./triggers.js";

/** A provider inbox subscription over an envelope's type and payload. */
export interface ProviderTriggerSource<Provider extends string, Event extends string> extends TriggerSource {
  readonly name: Provider;
  readonly filter: WebhookFilter & { readonly provider: Provider; readonly type: Event };
}

/** Shared implementation for generated provider declarations. */
export function providerTrigger<P extends string, E extends string>(
  provider: P, event: E, payload?: WebhookFilter,
): ProviderTriggerSource<P, E> {
  if (typeof event !== "string" || event.length === 0) throw new TypeError("provider event type must not be empty");
  // Validate separately so an invalid payload cannot become a scalar filter leaf.
  const filter = webhook(provider, payload).filter;
  return webhook(provider, {
    provider, type: event, ...(filter === undefined ? {} : { payload: filter }),
  }) as ProviderTriggerSource<P, E>;
}

export function triggerArgument(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value;
}
