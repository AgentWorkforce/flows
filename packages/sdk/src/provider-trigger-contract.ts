import { providerEventTypes, type TriggerSource } from '@relayflows/surface';
import type { PreflightRefusal } from './preflight.js';

/**
 * Author-time contract for provider subscriptions.
 *
 * A provider trigger is not a second trigger kind. `providerTrigger` lowers
 * `github.issues()` / `slack.mention('C123')` to an ordinary webhook source
 * whose inbox name is the provider and whose filter pins the event:
 *
 *     { kind: 'webhook', name: 'slack', filter: { provider, type, payload? } }
 *
 * `filter.provider` is therefore the marker that the author means provider
 * ingress (`POST /providers/<provider>`, validated by `providerInboxEvent`)
 * rather than the generic arbitrary-JSON route (`POST /<name>`). A plain
 * `webhook('release')` carries no `filter.provider` and is untouched here.
 *
 * WHY THIS EXISTS. `preflightWebhookTriggers` only asks whether the trigger's
 * name is registered in `flows.json`. That leaves a trapdoor with exactly the
 * shape this repo keeps paying for: a declaration the type system accepts and
 * nothing downstream can lower. `webhook('slack', { provider: 'slack', type:
 * 'nope', payload: {} })` type-checks, passes `flows check`, and is then
 * refused at ingress by `providerInboxEvent` — after deployment, on the first
 * real event. Every refusal below mirrors one of that function's three throws,
 * so `flows check` now fails where ingress would, before a run exists.
 *
 * The vocabulary is NOT redefined here. `providerEventTypes` is the generated
 * registry the surface builds from the pinned relayfile adapter mappings
 * (`scripts/generate-triggers.mjs`), and it is the same registry ingress reads.
 * One source of truth; this module only reads it.
 */

type ProviderRegistry = typeof providerEventTypes;

/** Events a provider publishes, or undefined when it has no generated module. */
function eventsFor(provider: string): readonly string[] | undefined {
  return Object.hasOwn(providerEventTypes, provider)
    ? providerEventTypes[provider as keyof ProviderRegistry]
    : undefined;
}

export interface ProviderDeclaration {
  /** The inbox the trigger routes to. At ingress the path is the authority. */
  readonly inbox: string;
  /** The provider named in the filter. */
  readonly provider: string;
  /** The pinned event type, when the filter declared one. */
  readonly type?: string;
}

/**
 * The provider subscription a trigger declares, or undefined when it is a
 * plain webhook. Reads only inert filter data; it never runs a handler.
 */
export function providerDeclaration(source: TriggerSource): ProviderDeclaration | undefined {
  if (source.kind !== 'webhook') return undefined;
  const filter = source.filter;
  if (filter === undefined) return undefined;
  const provider = filter['provider'];
  if (typeof provider !== 'string') return undefined;
  const type = filter['type'];
  return {
    inbox: source.name,
    provider,
    ...(typeof type === 'string' ? { type } : {}),
  };
}

function known(events: readonly string[]): string {
  return events.join(', ');
}

/**
 * Pure declared-surface check over provider subscriptions, before opening a
 * receiver or journal. Every refusal names a condition under which the
 * declaration can never match a delivered event — not a preference.
 */
export function preflightProviderTriggers(
  triggers: readonly TriggerSource[],
): PreflightRefusal[] {
  const refusals: PreflightRefusal[] = [];
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const declaration = providerDeclaration(trigger);
    if (declaration === undefined) continue;
    // One refusal per distinct declaration: a flow may legitimately register
    // several handlers on the same subscription, and repeating an identical
    // refusal per handler buries the list a reader has to act on.
    const key = JSON.stringify([declaration.inbox, declaration.provider, declaration.type ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);

    const events = eventsFor(declaration.inbox);
    if (events === undefined) {
      refusals.push({
        severity: 'refusal',
        kind: 'provider_unknown',
        executor: declaration.inbox,
        message: `provider trigger "${declaration.inbox}" has no generated event vocabulary; `
          + `provider ingress accepts only ${known(Object.keys(providerEventTypes))}`,
      });
      continue;
    }
    if (declaration.provider !== declaration.inbox) {
      refusals.push({
        severity: 'refusal',
        kind: 'provider_mismatch',
        executor: declaration.inbox,
        message: `provider trigger "${declaration.inbox}" declares provider "${declaration.provider}"; `
          + 'the inbox path is the authority at ingress, so this subscription can never be delivered',
      });
      continue;
    }
    if (declaration.type !== undefined && !events.includes(declaration.type)) {
      refusals.push({
        severity: 'refusal',
        kind: 'provider_event_unknown',
        executor: declaration.inbox,
        message: `provider trigger "${declaration.inbox}" declares event type "${declaration.type}", `
          + `which ${declaration.inbox} does not publish; known event types are ${known(events)}`,
      });
    }
  }
  return refusals;
}
