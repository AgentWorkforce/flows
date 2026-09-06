import { AsyncLocalStorage, executionAsyncId } from 'node:async_hooks';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { AuthoredPromiseGraph } from './authored-promise-graph.js';

type OperationToken = object;
type ResolverProbe = Set<number>;
interface PromiseAllGroup {
  aggregate: number;
  members: ReadonlySet<number>;
}
export interface AuthoredOperationInvocation {
  readonly asyncId: number;
  bound: boolean;
}

const nativePromiseThen = Promise.prototype.then;
const nativePromiseAll = Promise.all;
const nativePromiseAllSettled = Promise.allSettled;
const nativePromiseAny = Promise.any;
const nativePromiseRace = Promise.race;
const activeLifecycle = new AsyncLocalStorage<AuthoredFlowLifecycle>();
const stepOwners = new WeakMap<object, {
  lifecycle: AuthoredFlowLifecycle;
  operation: OperationToken;
}>();
let promiseAllObservers = 0;

/**
 * Combinators that record which authored operations an aggregate joins.
 *
 * This intercepts intrinsics, which is a real cost and is documented as such in
 * `ops/reviews/20260903-pr134-repair-0903.md`. It is here because a
 * combinator's aggregate has no runtime edge to its members: the aggregate's
 * resolution cause reaches only the member that settles it, so without this
 * registration `await Promise.all([a, b])` reports `a` unawaited. Every
 * alternative that recovers the link — comparing the `onrejected` callbacks the
 * combinator passes each element, for instance — is callback identity
 * inference, which is exactly the forgery class this contract closed.
 *
 * 2026-09-06: `allSettled`, `any` and `race` are intercepted here too. The
 * previous revision covered them by inheriting attribution in `promiseResolve`
 * from the context that resolved the aggregate, on the reasoning that this
 * covers every combinator without intercepting any of them. It does not. That
 * inheritance only fires when the RESOLVING context is itself attributed, so an
 * aggregate resolved by an ordinary promise inherits nothing — and for `any`
 * and `race` the resolver is by definition whichever member settles first,
 * which an ordinary member wins. Measured: multi-member `Promise.any` and
 * `Promise.race` rows carried a thrown derived failure to
 * `completionReason: "success"`. Single-member aggregates cannot show this,
 * because with one member the resolver is always that member.
 *
 * Attribution must not depend on WHICH member resolves the aggregate, and the
 * member edge is the only thing that makes it independent of that.
 *
 * Where these previously deviated from the specification they no longer do: a
 * non-iterable argument is handed straight to the intrinsic so it produces the
 * specified rejected promise rather than resolving `[]` or throwing
 * synchronously.
 */
type CombinatorIntrinsic = (
  this: PromiseConstructor,
  values: Iterable<unknown>,
) => Promise<unknown>;

function observeCombinator(
  native: CombinatorIntrinsic,
  name: string,
  requireOwnedMember = false,
): CombinatorIntrinsic {
  const observed = function (
    this: PromiseConstructor,
    values: Iterable<unknown>,
  ): Promise<unknown> {
    const passThrough = (): Promise<unknown> => native.call(this, values);
    if (!isIterable(values)) return passThrough();
    let members: unknown[];
    try {
      members = Array.from(values);
    } catch {
      return passThrough();
    }
    const aggregate = native.call(this, members);
    activeLifecycle.getStore()?.registerPromiseAll(members, aggregate, requireOwnedMember);
    return aggregate;
  };
  Object.defineProperty(observed, 'name', { value: name, configurable: true });
  Object.defineProperty(observed, 'length', { value: 1, configurable: true });
  return observed;
}

const observedPromiseAll = observeCombinator(nativePromiseAll as CombinatorIntrinsic, 'all');
const observedCombinators = [
  { key: 'all' as const, native: nativePromiseAll as CombinatorIntrinsic, observed: observedPromiseAll },
  {
    key: 'allSettled' as const,
    native: nativePromiseAllSettled as CombinatorIntrinsic,
    observed: observeCombinator(nativePromiseAllSettled as CombinatorIntrinsic, 'allSettled', true),
  },
  {
    key: 'any' as const,
    native: nativePromiseAny as CombinatorIntrinsic,
    observed: observeCombinator(nativePromiseAny as CombinatorIntrinsic, 'any', true),
  },
  {
    key: 'race' as const,
    native: nativePromiseRace as CombinatorIntrinsic,
    observed: observeCombinator(nativePromiseRace as CombinatorIntrinsic, 'race', true),
  },
];

function isIterable(value: unknown): value is Iterable<unknown> {
  if (value === null || value === undefined) return false;
  return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

/**
 * Runtime proof that a root operation participates in the continuation which
 * reaches done(). Promise resolver identity is never inferred from callback
 * source: a resolver counts only when invoking it settles the promise job that
 * called the operation's then method.
 */
export class AuthoredFlowLifecycle {
  private readonly graph: AuthoredPromiseGraph;
  private readonly activeResolverProbes: ResolverProbe[] = [];
  private readonly invocations = new Map<OperationToken, AuthoredOperationInvocation[]>();
  private readonly promiseAllAggregates = new Map<OperationToken, Set<number>>();
  private readonly promiseAllGroups: PromiseAllGroup[] = [];
  private readonly callbackFailures = new Map<OperationToken, unknown>();
  private completionAsyncId: number | undefined;
  private closed = false;

  constructor() {
    this.graph = new AuthoredPromiseGraph(
      () => activeLifecycle.getStore() === this,
      (asyncId) => {
        for (const probe of this.activeResolverProbes) probe.add(asyncId);
      },
    );
    installPromiseAllObserver();
    try {
      this.graph.enable();
    } catch (error) {
      uninstallPromiseAllObserver();
      throw error;
    }
  }

  runBody<T>(body: () => T): T {
    return activeLifecycle.run(this, body);
  }

  registerStep(step: object, operation: OperationToken): void {
    stepOwners.set(step, { lifecycle: this, operation });
  }

  registerPromiseAll(
    values: readonly unknown[],
    aggregate: Promise<unknown>,
    requireOwnedMember = false,
  ): void {
    const aggregateId = this.graph.idOf(aggregate);
    if (aggregateId === undefined) return;
    if (requireOwnedMember && !values.some((value) => (
      (typeof value === 'object' || typeof value === 'function')
      && value !== null
      && stepOwners.get(value)?.lifecycle === this
    ))) return;
    this.graph.registerRoot(aggregateId);
    const memberIds = new Set<number>();
    for (const value of values) {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null) continue;
      const memberId = this.graph.idOf(value);
      if (memberId !== undefined) memberIds.add(memberId);
      const owner = stepOwners.get(value);
      if (owner?.lifecycle !== this) continue;
      let operationAggregates = this.promiseAllAggregates.get(owner.operation);
      if (operationAggregates === undefined) {
        operationAggregates = new Set();
        this.promiseAllAggregates.set(owner.operation, operationAggregates);
      }
      operationAggregates.add(aggregateId);
    }
    this.promiseAllGroups.push({ aggregate: aggregateId, members: memberIds });
  }

  registerInvocation(
    operation: OperationToken,
    asyncId: number,
  ): AuthoredOperationInvocation {
    const invocation = { asyncId, bound: false };
    const operationInvocations = this.invocations.get(operation);
    if (operationInvocations === undefined) this.invocations.set(operation, [invocation]);
    else operationInvocations.push(invocation);
    this.graph.registerRoot(asyncId);
    return invocation;
  }

  markCompletion(): void {
    if (activeLifecycle.getStore() !== this) {
      throw new AuthoredFlowExecutionError(
        'unsupported_promise_lifecycle',
        'done() escaped its authored flow lifecycle scope',
      );
    }
    this.completionAsyncId = executionAsyncId();
  }

  invokeResolver<T>(
    invocation: AuthoredOperationInvocation,
    callback: () => T,
  ): T {
    const probe: ResolverProbe = new Set();
    this.activeResolverProbes.push(probe);
    try {
      return callback();
    } finally {
      this.activeResolverProbes.pop();
      if (invocation.asyncId > 0 && probe.has(invocation.asyncId)) {
        invocation.bound = true;
      }
    }
  }

  hasBoundConsumer(operation: OperationToken): boolean {
    return this.invocations.get(operation)?.some((invocation) => invocation.bound) ?? false;
  }

  isHandled(operation: OperationToken): boolean {
    const completion = this.completionAsyncId;
    const operationInvocations = this.invocations.get(operation);
    if (completion === undefined || operationInvocations === undefined) return false;
    const aggregates = this.aggregatesFor(operation);
    return operationInvocations.length > 0 && operationInvocations.every((invocation) =>
      invocation.bound && (
        this.graph.dependsOn(completion, invocation.asyncId)
        || [...aggregates].some((aggregate) => this.graph.dependsOn(completion, aggregate))
      ));
  }

  /**
   * Operations that still had derived work running when the body returned.
   *
   * This is the question the gate used to get wrong. It previously asked which
   * derived failures had *already landed*, and skipped every promise that had
   * not settled — so the same program passed or failed on how many microtask
   * ticks the failure took. Ten `await null`s, or any real derived I/O, cleared
   * the window.
   *
   * Whether derived work is still in flight when the body returns is not a
   * timing fact, it is a causal one: work the author awaited is settled at that
   * instant in every timing, and work the author did not await is pending in
   * every timing. Refusing on pending work therefore closes the race rather
   * than widening it — and it makes the *settled* set complete, so reading the
   * outcomes of the settled promises stops being a sample and becomes a total
   * answer over a closed set.
   *
   * Must be called before the gate awaits anything.
   */
  derivedWorkInFlight<T extends OperationToken>(operations: readonly T[]): T[] {
    return operations.filter((operation) =>
      this.graph.inFlightFrom(this.rootsFor(operation)).length > 0);
  }

  async observeCallbackFailures(operations: readonly OperationToken[]): Promise<void> {
    const observations: Promise<unknown>[] = [];
    for (const operation of operations) {
      for (const promise of this.graph.settledFrom(this.rootsFor(operation))) {
        observations.push(nativePromiseThen.call(
          promise,
          () => undefined,
          (error: unknown) => { this.recordCallbackFailure(operation, error); },
        ));
      }
    }
    await Promise.all(observations);
  }

  callbackFailure(operation: OperationToken): {
    readonly recorded: boolean;
    readonly value: unknown;
  } {
    return {
      recorded: this.callbackFailures.has(operation),
      value: this.callbackFailures.get(operation),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.graph.disable();
    this.graph.clear();
    this.invocations.clear();
    this.promiseAllAggregates.clear();
    this.promiseAllGroups.length = 0;
    this.callbackFailures.clear();
    this.activeResolverProbes.length = 0;
    uninstallPromiseAllObserver();
  }

  private rootsFor(operation: OperationToken): ReadonlySet<number> {
    const roots = new Set(
      (this.invocations.get(operation) ?? [])
        .filter((invocation) => invocation.bound)
        .map((invocation) => invocation.asyncId),
    );
    for (const aggregate of this.aggregatesFor(operation)) roots.add(aggregate);
    return roots;
  }

  private recordCallbackFailure(operation: OperationToken, error: unknown): void {
    if (!this.callbackFailures.has(operation)) this.callbackFailures.set(operation, error);
  }

  private aggregatesFor(operation: OperationToken): Set<number> {
    const aggregates = new Set(this.promiseAllAggregates.get(operation) ?? []);
    for (const invocation of this.invocations.get(operation) ?? []) {
      for (const group of this.promiseAllGroups) {
        if (
          group.members.size > 0
          && [...group.members].some((member) => this.graph.dependsOn(member, invocation.asyncId))
        ) {
          aggregates.add(group.aggregate);
        }
      }
    }
    return aggregates;
  }
}

function installPromiseAllObserver(): void {
  const slot = Promise as unknown as Record<string, CombinatorIntrinsic>;
  if (promiseAllObservers === 0) {
    for (const combinator of observedCombinators) {
      if (slot[combinator.key] !== combinator.native) {
        throw new AuthoredFlowExecutionError(
          'unsupported_promise_lifecycle',
          `authored flow execution requires the intrinsic Promise.${combinator.key}`,
        );
      }
    }
    for (const combinator of observedCombinators) slot[combinator.key] = combinator.observed;
  } else {
    for (const combinator of observedCombinators) {
      if (slot[combinator.key] !== combinator.observed) {
        throw new AuthoredFlowExecutionError(
          'unsupported_promise_lifecycle',
          `the authored flow Promise.${combinator.key} lifecycle contract was replaced`,
        );
      }
    }
  }
  promiseAllObservers += 1;
}

function uninstallPromiseAllObserver(): void {
  promiseAllObservers -= 1;
  if (promiseAllObservers > 0) return;
  promiseAllObservers = 0;
  const slot = Promise as unknown as Record<string, CombinatorIntrinsic>;
  for (const combinator of observedCombinators) slot[combinator.key] = combinator.native;
}
