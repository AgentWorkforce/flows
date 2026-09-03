import { executionAsyncId } from 'node:async_hooks';
import type { Step } from '@relayflows/surface';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import {
  AuthoredFlowLifecycle,
  type AuthoredOperationInvocation,
} from './authored-flow-lifecycle.js';

type OperationState = 'created' | 'running' | 'fulfilled' | 'rejected';
const nativePromiseThen = Promise.prototype.then;

/** A root authored operation whose outcome cannot be hidden by promise handlers. */
export class AuthoredFlowOperation<T> {
  readonly step: Step<T>;
  private state: OperationState = 'created';
  private thenInvoked = false;
  private rootFailureRecorded = false;
  private rootFailure: unknown;
  private callbackFailureRecorded = false;
  private callbackFailure: unknown;
  private readonly promise: Promise<T>;
  private readonly resolve: (value: T | PromiseLike<T>) => void;
  private readonly reject: (reason?: unknown) => void;

  constructor(
    readonly id: string,
    readonly verb: string,
    private readonly assertCanStart: () => void,
    private readonly start: () => Promise<T>,
    private readonly scope: AuthoredFlowLifecycle,
  ) {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    this.promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    this.resolve = resolve;
    this.reject = reject;

    observeRejection(this.promise, (error) => this.recordRootFailure(error));
    const operation = this;
    this.step = Object.freeze({
      gate(): never {
        throw new AuthoredFlowExecutionError(
          'unsupported_gate',
          'postfix gates are not lowered by the initial authored executor',
        );
      },
      then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        operation.thenInvoked = true;
        const invocation = operation.scope.registerInvocation(operation, executionAsyncId());
        void operation.begin();
        const derived = nativeThen(
          operation.promise,
          wrapResolver(operation, invocation, onfulfilled),
          wrapResolver(operation, invocation, onrejected),
        );
        return trackDerivedPromise(
          derived,
          (error) => operation.recordCallbackFailure(error),
        );
      },
    });
    this.scope.registerStep(this.step, this);
  }

  get lifecycle(): OperationState {
    return this.state;
  }

  get wasManuallyChained(): boolean {
    return this.thenInvoked && !this.scope.hasBoundConsumer(this);
  }

  get wasAwaited(): boolean {
    return this.scope.hasBoundConsumer(this);
  }

  get failure(): { readonly recorded: boolean; readonly value: unknown } {
    return { recorded: this.rootFailureRecorded, value: this.rootFailure };
  }

  get derivedFailure(): { readonly recorded: boolean; readonly value: unknown } {
    return { recorded: this.callbackFailureRecorded, value: this.callbackFailure };
  }

  cancel(error: unknown): void {
    if (this.state !== 'created') return;
    this.state = 'rejected';
    this.recordRootFailure(error);
    this.reject(error);
  }

  async waitForSettlement(): Promise<void> {
    await nativeThen(this.promise, () => undefined, () => undefined);
  }

  invokeResolver<TResult>(
    invocation: AuthoredOperationInvocation,
    callback: () => TResult,
  ): TResult {
    return this.scope.invokeResolver(invocation, callback);
  }

  private async begin(): Promise<void> {
    if (this.state !== 'created') return;
    try {
      this.assertCanStart();
      this.state = 'running';
      const value = await this.start();
      this.state = 'fulfilled';
      this.resolve(value);
    } catch (error) {
      this.state = 'rejected';
      this.recordRootFailure(error);
      this.reject(error);
    }
  }

  private recordRootFailure(error: unknown): void {
    if (this.rootFailureRecorded) return;
    this.rootFailureRecorded = true;
    this.rootFailure = error;
  }

  private recordCallbackFailure(error: unknown): void {
    if (this.callbackFailureRecorded) return;
    this.callbackFailureRecorded = true;
    this.callbackFailure = error;
  }
}

export async function verifyAuthoredOperations(
  flowName: string,
  operations: readonly AuthoredFlowOperation<unknown>[],
  lifecycle: AuthoredFlowLifecycle,
): Promise<void> {
  const canceled = new Set(operations.filter((operation) => operation.lifecycle === 'created'));

  if (canceled.size > 0) {
    const error = unawaitedError(flowName, [...canceled]);
    for (const operation of operations) operation.cancel(error);
  }

  await Promise.all(operations.map((operation) => operation.waitForSettlement()));
  await lifecycle.observeCallbackFailures(operations);
  const unawaited = operations.filter((operation) =>
    !lifecycle.isHandled(operation)
    || operation.lifecycle === 'created'
    || operation.lifecycle === 'running');

  const failed = operations.find((operation) =>
    operation.failure.recorded && !canceled.has(operation));
  if (failed !== undefined) {
    throw failed.failure.value;
  }
  const callbackFailed = operations.find((operation) =>
    operation.derivedFailure.recorded || lifecycle.callbackFailure(operation).recorded);
  if (callbackFailed !== undefined) {
    const failure = callbackFailed.derivedFailure.recorded
      ? callbackFailed.derivedFailure.value
      : lifecycle.callbackFailure(callbackFailed).value;
    throw new AuthoredFlowExecutionError(
      'operation_callback_failed',
      `flow "${flowName}" derived handler for ${formatOperation(callbackFailed)} rejected: ${describeError(failure)}`,
    );
  }
  if (unawaited.length > 0) {
    throw unawaitedError(flowName, unawaited);
  }
}

export async function stopAuthoredOperations(
  operations: readonly AuthoredFlowOperation<unknown>[],
  reason: unknown,
): Promise<void> {
  for (const operation of operations) operation.cancel(reason);
  await Promise.all(operations.map((operation) => operation.waitForSettlement()));
}

function unawaitedError(
  flowName: string,
  operations: readonly AuthoredFlowOperation<unknown>[],
): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError(
    'unawaited_step',
    `flow "${flowName}" returned with unawaited steps: ${operations.map(formatOperation).join(', ')}`,
  );
}

function formatOperation(operation: AuthoredFlowOperation<unknown>): string {
  return `${operation.id} (f.${operation.verb})`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observeRejection<T>(promise: Promise<T>, record: (error: unknown) => void): void {
  void nativeThen(promise, undefined, (error) => record(error));
}

function nativeThen<T, TResult1 = T, TResult2 = never>(
  promise: Promise<T>,
  onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
  onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
): Promise<TResult1 | TResult2> {
  return nativePromiseThen.call(promise, onfulfilled, onrejected) as Promise<TResult1 | TResult2>;
}

function wrapResolver<T, TValue, TResult>(
  operation: AuthoredFlowOperation<T>,
  invocation: AuthoredOperationInvocation,
  callback?: ((value: TValue) => TResult | PromiseLike<TResult>) | null,
): ((value: TValue) => TResult | PromiseLike<TResult>) | undefined {
  if (callback === undefined || callback === null) return undefined;
  return (value) => operation.invokeResolver(invocation, () => callback(value));
}

function trackDerivedPromise<T>(
  promise: Promise<T>,
  record: (error: unknown) => void,
): Promise<T> {
  observeRejection(promise, record);
  Object.defineProperty(promise, 'then', {
    value<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return trackDerivedPromise(
        nativeThen(promise, onfulfilled, onrejected),
        record,
      );
    },
  });
  return promise;
}
