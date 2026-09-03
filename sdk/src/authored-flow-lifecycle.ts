import {
  AsyncLocalStorage,
  createHook,
  executionAsyncId,
  type AsyncHook,
} from 'node:async_hooks';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

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
const activeLifecycle = new AsyncLocalStorage<AuthoredFlowLifecycle>();
const stepOwners = new WeakMap<object, {
  lifecycle: AuthoredFlowLifecycle;
  operation: OperationToken;
}>();
let promiseAllObservers = 0;

const observedPromiseAll = function <T>(
  this: PromiseConstructor,
  values: Iterable<T | PromiseLike<T>>,
): Promise<Awaited<T>[]> {
  const members = Array.from(values);
  const aggregate = nativePromiseAll.call(this, members) as Promise<Awaited<T>[]>;
  activeLifecycle.getStore()?.registerPromiseAll(members, aggregate);
  return aggregate;
};

/**
 * Runtime proof that a root operation participates in the continuation which
 * reaches done(). Promise resolver identity is never inferred from callback
 * source: a resolver counts only when invoking it settles the promise job that
 * called the operation's then method.
 */
export class AuthoredFlowLifecycle {
  private readonly hook: AsyncHook;
  private readonly triggers = new Map<number, number>();
  private readonly resolutionCauses = new Map<number, number>();
  private readonly promises = new Map<number, Promise<unknown>>();
  private readonly promiseIds = new WeakMap<object, number>();
  private readonly settledPromises = new Set<number>();
  private readonly activeResolverProbes: ResolverProbe[] = [];
  private readonly invocations = new Map<OperationToken, AuthoredOperationInvocation[]>();
  private readonly promiseAllAggregates = new Map<OperationToken, Set<number>>();
  private readonly promiseAllGroups: PromiseAllGroup[] = [];
  private readonly callbackFailures = new Map<OperationToken, unknown>();
  private completionAsyncId: number | undefined;
  private closed = false;

  constructor() {
    this.hook = createHook({
      init: (asyncId, type, triggerAsyncId, resource) => {
        if (type !== 'PROMISE' || typeof resource !== 'object' || resource === null) return;
        this.triggers.set(asyncId, triggerAsyncId);
        this.promises.set(asyncId, resource as Promise<unknown>);
        this.promiseIds.set(resource, asyncId);
      },
      promiseResolve: (asyncId) => {
        this.settledPromises.add(asyncId);
        const cause = executionAsyncId();
        if (cause !== asyncId) this.resolutionCauses.set(asyncId, cause);
        for (const probe of this.activeResolverProbes) probe.add(asyncId);
      },
    });
    installPromiseAllObserver();
    try {
      this.hook.enable();
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

  registerPromiseAll(values: readonly unknown[], aggregate: Promise<unknown>): void {
    const aggregateId = this.promiseIds.get(aggregate);
    if (aggregateId === undefined) return;
    const memberIds = new Set<number>();
    for (const value of values) {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null) continue;
      const memberId = this.promiseIds.get(value);
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
        this.dependsOn(completion, invocation.asyncId)
        || [...aggregates].some((aggregate) => this.dependsOn(completion, aggregate))
      ));
  }

  async observeCallbackFailures(operations: readonly OperationToken[]): Promise<void> {
    const observations: Promise<unknown>[] = [];
    const snapshot = [...this.promises.entries()];
    for (const operation of operations) {
      const roots = new Set(
        (this.invocations.get(operation) ?? [])
          .filter((invocation) => invocation.bound)
          .map((invocation) => invocation.asyncId),
      );
      for (const aggregate of this.aggregatesFor(operation)) roots.add(aggregate);
      for (const [asyncId, promise] of snapshot) {
        if (!this.settledPromises.has(asyncId) || roots.has(asyncId)) continue;
        if (![...roots].some((root) => this.triggerDescendsFrom(asyncId, root))) continue;
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
    this.hook.disable();
    this.promises.clear();
    uninstallPromiseAllObserver();
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
          && [...group.members].some((member) => this.dependsOn(member, invocation.asyncId))
        ) {
          aggregates.add(group.aggregate);
        }
      }
    }
    return aggregates;
  }

  private dependsOn(descendant: number, ancestor: number): boolean {
    return this.dependenciesOf(descendant).has(ancestor);
  }

  private dependenciesOf(start: number): Set<number> {
    const found = new Set<number>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (found.has(current)) continue;
      found.add(current);
      const trigger = this.triggers.get(current);
      const cause = this.resolutionCauses.get(current);
      if (trigger !== undefined && trigger !== current) pending.push(trigger);
      if (cause !== undefined && cause !== current) pending.push(cause);
    }
    return found;
  }

  private triggerDescendsFrom(descendant: number, ancestor: number): boolean {
    let current: number | undefined = descendant;
    const seen = new Set<number>();
    while (current !== undefined && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current);
      current = this.triggers.get(current);
    }
    return false;
  }
}

function installPromiseAllObserver(): void {
  if (promiseAllObservers === 0) {
    if (Promise.all !== nativePromiseAll) {
      throw new AuthoredFlowExecutionError(
        'unsupported_promise_lifecycle',
        'authored flow execution requires the intrinsic Promise.all',
      );
    }
    Promise.all = observedPromiseAll as PromiseConstructor['all'];
  } else if (Promise.all !== observedPromiseAll) {
    throw new AuthoredFlowExecutionError(
      'unsupported_promise_lifecycle',
      'the authored flow Promise.all lifecycle contract was replaced',
    );
  }
  promiseAllObservers += 1;
}

function uninstallPromiseAllObserver(): void {
  promiseAllObservers -= 1;
  if (promiseAllObservers > 0) return;
  promiseAllObservers = 0;
  Promise.all = nativePromiseAll;
}
