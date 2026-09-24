import type { RelayClientOptions, RelayTransport } from '@relayfile/relay-helpers/transport';
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
  function wrap(client: object, prefix = ''): object {
    return Object.fromEntries(Object.entries(client).map(([key, value]) => {
      const verb = `${prefix}${key}`;
      if (typeof value === 'function') return [key, key === 'path'
        ? value.bind(client)
        : (...args: unknown[]) => {
          while (args.length && args.at(-1) === undefined) args.pop();
          return dispatch({ type: 'effect', provider, verb, args });
        }];
      return [key, value && typeof value === 'object' ? wrap(value, `${verb}.`) : value];
    }));
  }
  return wrap(factory({ transport: unavailableTransport }));
}

/** Resolve only own, generated client methods; never arbitrary prototype members. */
export async function invokeHelper(factory: HelperFactory, call: HelperCall, transport: RelayTransport): Promise<unknown> {
  let target: unknown = factory({ transport });
  const parts = call.verb.split('.');
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, part)) throw new Error('Unknown helper resource');
    target = (target as Record<string, unknown>)[part];
  }
  const verb = parts.at(-1)!;
  if (!target || typeof target !== 'object' || !Object.hasOwn(target, verb) || verb === 'path') throw new Error('Unknown helper verb');
  const method = (target as Record<string, unknown>)[verb];
  if (typeof method !== 'function') throw new Error('Unknown helper verb');
  return await method.apply(target, call.args) ?? null;
}
