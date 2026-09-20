import { helperProviders } from './helpers/providers.js';

/**
 * How much of a provider's namespace the generated helper can actually reach.
 *
 * `true` — the upstream writeback client exists and every catalog resource
 * dispatches. It is NOT a claim that the whole vendor API is reachable.
 * `'partial'` — usable, but known to omit workflows the namespace suggests;
 * `note` says which, and `resources` is the whole of what dispatches.
 * `false` — no upstream writeback client at all.
 */
export type HelperSupport = true | 'partial' | false;

export interface HelperProviderEntry {
  readonly provider: string;
  readonly namespace: string;
  readonly mockEnv: string;
  readonly supported: HelperSupport;
  /** Writeback resources this helper exposes, sorted. */
  readonly resources: readonly string[];
  /** The author-facing limitation; present only where support is partial. */
  readonly note?: string;
}

const entries: readonly HelperProviderEntry[] = helperProviders;

/** The catalog row for a provider, with `note` typed as the optional it is. */
export function helperProviderEntry(provider: string): HelperProviderEntry | undefined {
  return entries.find(entry => entry.provider === provider);
}

/**
 * The one refusal wording for a helper member the provider does not have.
 *
 * `f.gitlab.issues` used to fail as `undefined is not a function`, which tells
 * an author nothing about the writeback catalog behind the namespace. Every
 * refusal names the requested member AND the available ones, so the limit is
 * learned at the call site instead of by dumping the catalog. Preflight and
 * the runtime guard share this function so they cannot word it differently.
 */
export function unsupportedHelperMemberMessage(
  provider: string, member: string, available: readonly string[], resource?: string,
): string {
  const entry = helperProviderEntry(provider);
  const namespace = entry?.namespace ?? provider;
  const path = `f.${namespace}${resource === undefined ? '' : `.${resource}`}.${member}`;
  const scope = resource === undefined ? 'available resources' : `available verbs on ${resource}`;
  return `${path} is unavailable; ${scope}: ${[...available].sort().join(', ')}.`
    + (entry?.note === undefined ? '' : ` ${entry.note}`);
}

export class UnsupportedHelperMemberError extends Error {
  constructor(
    readonly provider: string,
    readonly member: string,
    readonly available: readonly string[],
    /** The resource the member was looked up on, for a bad verb. */
    readonly resource?: string,
  ) {
    super(unsupportedHelperMemberMessage(provider, member, available, resource));
    this.name = 'UnsupportedHelperMemberError';
  }
}

/**
 * Wrap a bound helper so an absent member refuses instead of reading
 * `undefined`. Dot, bracket and aliased access all go through `get`.
 *
 * Ordinary object behavior is preserved: symbols, `then` (so the helper can be
 * awaited or resolved), `toJSON`, inherited `Object.prototype` methods, key
 * enumeration and spread. Nothing here dispatches an effect or performs
 * provider I/O — refusing an unknown resource must not touch the provider.
 */
export function guardHelperMembers<T extends object>(provider: string, target: T, resource?: string): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string' && !(key in object) && key !== 'then' && key !== 'toJSON') {
        throw new UnsupportedHelperMemberError(provider, key, Object.keys(object), resource);
      }
      return Reflect.get(object, key, receiver);
    },
  });
}
