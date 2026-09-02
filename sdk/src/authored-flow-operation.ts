import type { Step } from '@relayflows/surface';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

type OperationState = 'created' | 'running' | 'fulfilled' | 'rejected';

/** A root authored operation whose outcome cannot be hidden by promise handlers. */
export class AuthoredFlowOperation<T> {
  readonly step: Step<T>;
  private state: OperationState = 'created';
  private awaited = false;
  private manuallyChained = false;
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
        if (isAwaitContinuation(onfulfilled, onrejected)) {
          operation.awaited = true;
        } else {
          operation.manuallyChained = true;
        }
        void operation.begin();
        const derived = nativeThen(operation.promise, onfulfilled, onrejected);
        return trackDerivedPromise(
          derived,
          (error) => operation.recordCallbackFailure(error),
        );
      },
    });
  }

  get lifecycle(): OperationState {
    return this.state;
  }

  get wasManuallyChained(): boolean {
    return this.manuallyChained;
  }

  get wasAwaited(): boolean {
    return this.awaited;
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
): Promise<void> {
  const unawaited = operations.filter((operation) =>
    !operation.wasAwaited
    || operation.wasManuallyChained
    || operation.lifecycle === 'created'
    || operation.lifecycle === 'running');
  const canceled = new Set(
    unawaited.filter((operation) => operation.lifecycle === 'created'),
  );

  if (canceled.size > 0) {
    const error = unawaitedError(flowName, unawaited);
    for (const operation of operations) operation.cancel(error);
  }

  await Promise.all(operations.map((operation) => operation.waitForSettlement()));

  const failed = operations.find((operation) =>
    operation.failure.recorded && !canceled.has(operation));
  if (failed !== undefined) {
    throw failed.failure.value;
  }
  const callbackFailed = operations.find((operation) => operation.derivedFailure.recorded);
  if (callbackFailed !== undefined) {
    throw new AuthoredFlowExecutionError(
      'operation_callback_failed',
      `flow "${flowName}" derived handler for ${formatOperation(callbackFailed)} rejected: ${describeError(callbackFailed.derivedFailure.value)}`,
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

function isAwaitContinuation<T, TResult1, TResult2>(
  onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
  onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
): boolean {
  // Await assimilation supplies paired built-in resolving functions. A direct
  // PromiseLike.then call supplies authored callbacks and is refused later.
  return typeof onfulfilled === 'function'
    && typeof onrejected === 'function'
    && isNativeFunction(onfulfilled)
    && isNativeFunction(onrejected);
}

function isNativeFunction(value: (...args: never[]) => unknown): boolean {
  return Function.prototype.toString.call(value) === 'function () { [native code] }';
}

function nativeThen<T, TResult1 = T, TResult2 = never>(
  promise: Promise<T>,
  onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
  onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
): Promise<TResult1 | TResult2> {
  return Promise.prototype.then.call(promise, onfulfilled, onrejected) as Promise<TResult1 | TResult2>;
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
