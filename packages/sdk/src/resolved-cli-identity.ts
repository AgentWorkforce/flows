import type { FlowSpec } from './spec.js';

/**
 * Host-proved CLI identities are deliberately out-of-band from the authoring
 * schema. A flow cannot claim that a canonical `cli.js` target is Claude; only
 * the successful preflight that resolved the authored `claude` declaration
 * can attach that identity before kernel lowering.
 */
const IDENTITIES = new WeakMap<object, ReadonlyMap<string, string>>();

export function resolvedCliIdentities(value: unknown): ReadonlyMap<string, string> | undefined {
  return typeof value === 'object' && value !== null ? IDENTITIES.get(value) : undefined;
}

export function rememberResolvedCliIdentities<T extends FlowSpec>(
  flow: T,
  identities: ReadonlyMap<string, string>,
): T {
  IDENTITIES.set(flow, new Map(identities));
  return flow;
}

export function inheritResolvedCliIdentities<T extends FlowSpec>(source: unknown, flow: T): T {
  const identities = resolvedCliIdentities(source);
  return identities === undefined ? flow : rememberResolvedCliIdentities(flow, identities);
}
