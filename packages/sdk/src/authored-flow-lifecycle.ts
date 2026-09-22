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
const activeLifecycle = new AsyncLocalStorage<AuthoredFlowLifecycle>();
const stepOwners = new WeakMap<object, {
  lifecycle: AuthoredFlowLifecycle;
  operation: OperationToken;
}>();

/**
 * The four intrinsic combinators, intercepted so that an aggregate's membership
 * is recorded exactly.
 *
 * **Why interception, and why all four.** An aggregate is derived from *every*
 * member, but the runtime supplies an edge to only *one* of them: the aggregate
 * is resolved inside the reaction of whichever member settled last (`all`,
 * `allSettled`) or first (`race`, `any`). Inferring membership from that edge is
 * a sufficient rule, never a necessary one, and it fails in both directions —
 * `Promise.allSettled([step, slowerUnrelated])` hid a rejected derived chain
 * behind an aggregate an unrelated promise resolved, and
 * `await Promise.allSettled([a, b])` refused every member except the last to
 * settle. Membership cannot be recovered from the promise graph, so it is
 * recorded here, where the combinator is called and the member list is in hand.
 *
 * A previous revision registered `Promise.all` only, and claimed a
 * resolution-context rule covered "every combinator, present and future". That
 * claim was wrong: it covered whichever member happened to resolve the
 * aggregate. What is true is narrower and is what the code now implements —
 * these four are exact, and `adoptFromResolvingContext` in the promise graph is
 * a best-effort fallback for aggregates built by hand.
 *
 * The interception is disclosed to authors in `docs/SURFACE.md`. It is spec
 * transparent: `Symbol.iterator` is read exactly once (as the intrinsic does),
 * a non-iterable is handed to the intrinsic so it produces the specified
 * rejected promise, `this` is honoured for subclasses, and `name`/`length`
 * match.
 */
const COMBINATORS = ['all', 'allSettled', 'any', 'race'] as const;
type CombinatorName = (typeof COMBINATORS)[number];
type Combinator = (this: PromiseConstructor, values: Iterable<unknown>) => Promise<unknown>;

const nativeCombinators = Object.freeze(
  Object.fromEntries(COMBINATORS.map((name) => [name, Promise[name] as unknown as Combinator])),
) as Readonly<Record<CombinatorName, Combinator>>;

const observedCombinators: Record<CombinatorName, Combinator> = Object.fromEntries(
  COMBINATORS.map((name) => {
    const native = nativeCombinators[name];
    const observed = function (
      this: PromiseConstructor,
      values: Iterable<unknown>,
    ): Promise<unknown> {
      const members = collectMembers(values);
      if (members === undefined) return native.call(this, values);
      const aggregate = native.call(this, members);
      activeLifecycle.getStore()?.registerCombinator(members, aggregate);
      return aggregate;
    };
    Object.defineProperty(observed, 'name', { value: name, configurable: true });
    Object.defineProperty(observed, 'length', { value: 1, configurable: true });
    return [name, observed];
  }),
) as Record<CombinatorName, Combinator>;

let combinatorObservers = 0;

/**
 * Drain an iterable into an array, reading `Symbol.iterator` exactly once.
 *
 * Returns `undefined` when the argument is not iterable or iteration threw, so
 * the caller hands the original value to the intrinsic and the author sees the
 * intrinsic's own behaviour. A previous revision used `isIterable()` followed by
 * `Array.from()`, which invoked a `Symbol.iterator` getter twice where the
 * intrinsic invokes it once.
 */
function collectMembers(values: Iterable<unknown>): unknown[] | undefined {
  if (values === null || values === undefined) return undefined;
  let iteratorMethod: unknown;
  try {
    iteratorMethod = (values as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  } catch {
    return undefined;
  }
  if (typeof iteratorMethod !== 'function') return undefined;
  try {
    return [...(values as Iterable<unknown>)];
  } catch {
    return undefined;
  }
}

/**
 * Runtime proof that a root operation participates in the continuation which
 * reaches done(). Promise resolver identity is never inferred from callback
 * source: a resolver counts only when invoking it settles the promise job that
 * called the operation's then method.
 */
export class AuthoredFlowLifecycle {
  /**
   * Installed by the executor: runs an operation's predicate gate (if any) on
   * its resolved value before the operation fulfills. Lives on the lifecycle
   * so EVERY authored operation — core steps, helpers, MCP, plugins — passes
   * through it; a gate accepted on a Step must never be silently ignored.
   */
  applyPredicateGate: (<T>(operation: { id: string; predicateGate: unknown }, value: T) => Promise<T>) | undefined = undefined;
  private readonly graph: AuthoredPromiseGraph;
  private readonly activeResolverProbes: ResolverProbe[] = [];
  private readonly invocations = new Map<OperationToken, AuthoredOperationInvocation[]>();
  private readonly promiseAllAggregates = new Map<OperationToken, Set<number>>();
  private readonly promiseAllGroups: PromiseAllGroup[] = [];
  private readonly callbackFailures = new Map<OperationToken, unknown>();
  private completionAsyncId: number | undefined;
  private closed = false;
  /** Bumped by every invocation and combinator registration; with the graph's version it keys `groupsByInvocation`. */
  private registrations = 0;
  private groupsByInvocation: { readonly key: string; readonly groups: Map<number, ReadonlySet<number>> } | undefined;

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

  registerCombinator(values: readonly unknown[], aggregate: Promise<unknown>): void {
    const aggregateId = this.graph.idOf(aggregate);
    if (aggregateId === undefined) return;
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
    this.registrations++;
  }

  registerInvocation(
    operation: OperationToken,
    asyncId: number,
  ): AuthoredOperationInvocation {
    const invocation = { asyncId, bound: false };
    const operationInvocations = this.invocations.get(operation);
    if (operationInvocations === undefined) this.invocations.set(operation, [invocation]);
    else operationInvocations.push(invocation);
    this.registrations++;
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
    const inFlight = this.graph.rootsInFlight();
    return operations.filter((operation) =>
      [...this.rootsFor(operation)].some((root) => inFlight.has(root)));
  }

  /**
   * Observe each settled derived promise once, crediting a rejection to every
   * operation whose roots it derives from. Observing it once per operation
   * instead — each after a scan of every tracked promise — was the gate's
   * second quadratic term: roots of a task graph overlap heavily, so every
   * operation re-observed most of the flow.
   */
  async observeCallbackFailures(operations: readonly OperationToken[]): Promise<void> {
    const operationsByRoot = new Map<number, OperationToken[]>();
    for (const operation of operations) {
      for (const root of this.rootsFor(operation)) {
        const owners = operationsByRoot.get(root);
        if (owners === undefined) operationsByRoot.set(root, [operation]);
        else owners.push(operation);
      }
    }
    const owners = new Map<Promise<unknown>, Set<OperationToken>>();
    for (const { root, handle } of this.graph.settledWithRoots()) {
      const rootOwners = operationsByRoot.get(root);
      if (rootOwners === undefined) continue;
      let promiseOwners = owners.get(handle);
      if (promiseOwners === undefined) owners.set(handle, promiseOwners = new Set());
      for (const operation of rootOwners) promiseOwners.add(operation);
    }
    const observations: Promise<unknown>[] = [];
    for (const [promise, promiseOwners] of owners) {
      observations.push(nativePromiseThen.call(
        promise,
        () => undefined,
        (error: unknown) => { for (const operation of promiseOwners) this.recordCallbackFailure(operation, error); },
      ));
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
    this.groupsByInvocation = undefined;
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
    const groups = this.aggregatesByInvocation();
    for (const invocation of this.invocations.get(operation) ?? []) {
      for (const aggregate of groups.get(invocation.asyncId) ?? []) aggregates.add(aggregate);
    }
    return aggregates;
  }

  /**
   * For each invocation, the aggregates of every combinator group with a
   * member that depends on it. Asked per group member per invocation, this was
   * the gate's quadratic hot path: each question re-walked the member's whole
   * ancestry. It is now one batch pass, recomputed only when the graph or the
   * registrations have changed since the last gate question.
   */
  private aggregatesByInvocation(): Map<number, ReadonlySet<number>> {
    const key = `${this.graph.version}:${this.registrations}`;
    if (this.groupsByInvocation?.key === key) return this.groupsByInvocation.groups;
    const targets: number[] = [];
    for (const operationInvocations of this.invocations.values()) {
      for (const invocation of operationInvocations) targets.push(invocation.asyncId);
    }
    const members = [...new Set(this.promiseAllGroups.flatMap((group) => [...group.members]))];
    const reached = this.graph.dependenciesAmong(members, targets);
    const groups = new Map<number, Set<number>>();
    for (const group of this.promiseAllGroups) {
      for (const member of group.members) {
        for (const target of reached.get(member) ?? []) {
          let aggregates = groups.get(target);
          if (aggregates === undefined) groups.set(target, aggregates = new Set());
          aggregates.add(group.aggregate);
        }
      }
    }
    this.groupsByInvocation = { key, groups };
    return groups;
  }
}

function installPromiseAllObserver(): void {
  if (combinatorObservers === 0) {
    for (const name of COMBINATORS) {
      if (Promise[name] !== (nativeCombinators[name] as unknown)) {
        throw new AuthoredFlowExecutionError(
          'unsupported_promise_lifecycle',
          `authored flow execution requires the intrinsic Promise.${name}`,
        );
      }
    }
    for (const name of COMBINATORS) {
      (Promise as unknown as Record<string, unknown>)[name] = observedCombinators[name];
    }
  } else {
    for (const name of COMBINATORS) {
      if (Promise[name] !== (observedCombinators[name] as unknown)) {
        throw new AuthoredFlowExecutionError(
          'unsupported_promise_lifecycle',
          `the authored flow Promise.${name} lifecycle contract was replaced`,
        );
      }
    }
  }
  combinatorObservers += 1;
}

function uninstallPromiseAllObserver(): void {
  combinatorObservers -= 1;
  if (combinatorObservers > 0) return;
  combinatorObservers = 0;
  for (const name of COMBINATORS) {
    (Promise as unknown as Record<string, unknown>)[name] = nativeCombinators[name];
  }
}
