import type { RelayClientOptions, RelayTransport } from '@relayfile/relay-helpers/transport';
import { guardHelperMembers, helperProviderEntry, UnsupportedHelperMemberError } from './helper-support.js';
import type { Step } from './step.js';

/** Promise-returning client verbs become lazy, journal-owned steps. */
export type JournalHelper<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Step<R>
    : T[K] extends (...args: infer A) => infer R ? (...args: A) => R
    : T[K] extends object ? JournalHelper<T[K]> : T[K];
};
export interface HelperCall {
  type: 'effect';
  provider: string;
  verb: string;
  args: unknown[];
}
export type EffectDispatcher = <T>(call: HelperCall) => Step<T>;
export interface UnavailableHelper { readonly available: false }
export type HelperFactory = (options: RelayClientOptions) => object;

const unavailableTransport: RelayTransport = {
  async read() { throw new Error('Helper I/O requires a journaled step'); },
  async list() { throw new Error('Helper I/O requires a journaled step'); },
  async write() { throw new Error('Helper I/O requires a journaled step'); },
};

export function bindHelper<T extends object>(provider: string, factory: (options: RelayClientOptions) => T, dispatch: EffectDispatcher): JournalHelper<T>;
export function bindHelper(provider: string, factory: undefined, dispatch: EffectDispatcher): UnavailableHelper;
export function bindHelper(provider: string, factory: HelperFactory | undefined, dispatch: EffectDispatcher): object {
  if (!factory) return Object.freeze({ available: false });
  // A partially supported provider guards member access: its namespace promises
  // workflows its writeback catalog does not carry, so `f.gitlab.issues` must
  // name what is available instead of reading `undefined`.
  const partial = helperProviderEntry(provider)?.supported === 'partial';
  function wrap(client: object, prefix = ''): object {
    const bound = Object.fromEntries(Object.entries(client).map(([key, value]) => {
      const verb = `${prefix}${key}`;
      if (typeof value === 'function') return [key, key === 'path'
        ? value.bind(client)
        : (...args: unknown[]) => {
          while (args.length && args.at(-1) === undefined) args.pop();
          return dispatch({ type: 'effect', provider, verb, args });
        }];
      return [key, value && typeof value === 'object' ? wrap(value, `${verb}.`) : value];
    }));
    return partial ? guardHelperMembers(provider, bound, prefix === '' ? undefined : prefix.slice(0, -1)) : bound;
  }
  return wrap(factory({ transport: unavailableTransport }));
}

/**
 * An authored envelope reaches `invokeHelper` without ever touching the bound
 * helper's properties, so the same refusal is repeated here. Non-partial
 * providers keep their existing generic diagnostics.
 */
function unknownMember(
  provider: string, member: string, container: unknown, resource: string | undefined, kind: 'resource' | 'verb',
): Error {
  if (helperProviderEntry(provider)?.supported !== 'partial') {
    return new Error(kind === 'resource' ? 'Unknown helper resource' : 'Unknown helper verb');
  }
  // `path` builds a path synchronously and is never dispatchable, so naming it
  // as an available verb would send the author at a call that cannot work.
  const available = container !== null && typeof container === 'object'
    ? Object.keys(container).filter(key => kind === 'resource' || key !== 'path') : [];
  return new UnsupportedHelperMemberError(provider, member, available, resource);
}

/** Resolve only own, generated client methods; never arbitrary prototype members. */
export async function invokeHelper(factory: HelperFactory, call: HelperCall, transport: RelayTransport): Promise<unknown> {
  let target: unknown = factory({ transport });
  const parts = call.verb.split('.');
  let resource: string | undefined;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, part)) {
      throw unknownMember(call.provider, part, target, resource, 'resource');
    }
    target = (target as Record<string, unknown>)[part];
    resource = resource === undefined ? part : `${resource}.${part}`;
  }
  const verb = parts.at(-1)!;
  if (!target || typeof target !== 'object' || !Object.hasOwn(target, verb) || verb === 'path') {
    throw unknownMember(call.provider, verb, target, resource, 'verb');
  }
  const method = (target as Record<string, unknown>)[verb];
  if (typeof method !== 'function') throw unknownMember(call.provider, verb, target, resource, 'verb');
  return await method.apply(target, call.args) ?? null;
}
