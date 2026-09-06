import { describe, expect, it } from 'vitest';
import {
  AuthoredFlowOperation,
  verifyAuthoredOperations,
} from '../src/authored-flow-operation.js';
import { AuthoredFlowLifecycle } from '../src/authored-flow-lifecycle.js';

const verbs = ['run', 'llm', 'agent'] as const;

function operation(
  verb: string,
  lifecycle: AuthoredFlowLifecycle,
  index: number,
): AuthoredFlowOperation<string> {
  return new AuthoredFlowOperation(
    `${verb}-${index}`,
    verb,
    () => undefined,
    async () => `${verb}-result`,
    lifecycle,
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function executeLifecycle(
  name: string,
  verb: string,
  body: (create: () => AuthoredFlowOperation<string>) => Promise<void>,
): Promise<void> {
  const lifecycle = new AuthoredFlowLifecycle();
  const operations: AuthoredFlowOperation<unknown>[] = [];
  const create = (): AuthoredFlowOperation<string> => {
    const authored = operation(verb, lifecycle, operations.length + 1);
    operations.push(authored as AuthoredFlowOperation<unknown>);
    return authored;
  };
  try {
    const bodyPromise = lifecycle.runBody(async () => {
      await body(create);
      lifecycle.markCompletion();
    });
    await bodyPromise;
    await verifyAuthoredOperations(name, operations, lifecycle);
  } finally {
    lifecycle.close();
  }
}

describe.each(verbs)('authored %s operation lifecycle', (verb) => {
  it('refuses Promise.withResolvers callbacks as proof of await', async () => {
    await expect(executeLifecycle(`native-resolver-${verb}`, verb, async (create) => {
      const deferred = Promise.withResolvers<string>();
      create().step.then(deferred.resolve, deferred.reject);
      await settle();
    }))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });

  it('refuses an ignored Promise.resolve assimilation', async () => {
    await expect(executeLifecycle(`ignored-resolve-${verb}`, verb, async (create) => {
      void Promise.resolve(create().step);
      await settle();
    }))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });

  it('refuses an ignored Promise.all assimilation', async () => {
    await expect(executeLifecycle(`ignored-all-${verb}`, verb, async (create) => {
      void Promise.all([create().step, create().step]);
      await settle();
    }))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });

  it('retains a nested callback rejection outside the root thenable', async () => {
    await expect(executeLifecycle(`nested-callback-${verb}`, verb, async (create) => {
      await Promise.resolve(create().step)
        .then(() => { throw new Error('nested callback was handled and forgotten'); })
        .catch(() => undefined)
        .finally(() => undefined);
    }))
      .rejects.toMatchObject({ code: 'operation_callback_failed' });
  });

  it('refuses callback chaining when Function.prototype.toString is forged', async () => {
    await expect(executeLifecycle(`forged-callback-${verb}`, verb, async (create) => {
      const originalToString = Function.prototype.toString;
      Function.prototype.toString = () => 'function () { [native code] }';
      try {
        create().step.then(() => undefined, () => undefined);
        await settle();
      } finally {
        Function.prototype.toString = originalToString;
      }
    }))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });

  it('accepts direct await, Promise.resolve, and Promise.all consumers', async () => {
    await executeLifecycle(`direct-await-${verb}`, verb, async (create) => {
      await create().step;
    });
    await executeLifecycle(`resolved-await-${verb}`, verb, async (create) => {
      await Promise.resolve(create().step);
    });
    await executeLifecycle(`all-await-${verb}`, verb, async (create) => {
      await Promise.all([create().step, create().step]);
    });
    await executeLifecycle(`wrapped-all-await-${verb}`, verb, async (create) => {
      await Promise.all([Promise.resolve(create().step), Promise.resolve(create().step)]);
    });
  });
});

it('isolates concurrent Promise.all lifecycle scopes', async () => {
  await Promise.all([
    executeLifecycle('concurrent-run-a', 'run', async (create) => {
      await Promise.all([create().step, create().step]);
    }),
    executeLifecycle('concurrent-run-b', 'run', async (create) => {
      await Promise.all([create().step, create().step]);
    }),
  ]);
});

// P1-B (repair 2026-09-03): the completion gate used to walk the whole
// process-wide promise graph once per candidate promise per operation root. A
// 23 ms body with 30 000 ordinary in-flow awaits then spent 98 s in the gate
// (measured at 59c062cf: 5 000 -> 1763 ms, 30 000 -> 98 379 ms — quadratic).
// Attribution is now eager and O(1) per promise, so the gate is linear. The
// bound below is ~30x the measured 35 ms and ~2800x under the old cost: it
// cannot be met by anything quadratic, and it will not flake on a slow host.
it('completes the gate in linear time over a body with 30000 ordinary awaits', async () => {
  const lifecycle = new AuthoredFlowLifecycle();
  const operations: AuthoredFlowOperation<unknown>[] = [];
  try {
    await lifecycle.runBody(async () => {
      const authored = operation('run', lifecycle, 1);
      operations.push(authored as AuthoredFlowOperation<unknown>);
      await authored.step;
      for (let index = 0; index < 30_000; index++) await Promise.resolve(index);
      lifecycle.markCompletion();
    });
    const startedAt = Date.now();
    await verifyAuthoredOperations('linear-gate', operations, lifecycle);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  } finally {
    lifecycle.close();
  }
});

// P1-B, second half: the graph used to retain every promise created ANYWHERE in
// the process for the life of the flow (a probe measured 20 002 unrelated
// promises held by strong reference). Only promises created inside the flow's
// own async scope are tracked now.
it('does not track promises created outside the flow body', async () => {
  const lifecycle = new AuthoredFlowLifecycle();
  try {
    const unrelated: Promise<number>[] = [];
    for (let index = 0; index < 5_000; index++) unrelated.push(Promise.resolve(index));
    await Promise.all(unrelated);
    expect(trackedPromiseCount(lifecycle)).toBe(0);
  } finally {
    lifecycle.close();
  }
});

// P2-B (repair 2026-09-03): close() released `promises` but left `triggers`,
// `settledPromises` and `resolutionCauses` populated (180 031 / 180 030 / 30 010
// entries in the signoff measurement).
it('releases every tracked map on close', async () => {
  const lifecycle = new AuthoredFlowLifecycle();
  const operations: AuthoredFlowOperation<unknown>[] = [];
  await lifecycle.runBody(async () => {
    const authored = operation('run', lifecycle, 1);
    operations.push(authored as AuthoredFlowOperation<unknown>);
    await authored.step;
    for (let index = 0; index < 500; index++) await Promise.resolve(index);
    lifecycle.markCompletion();
  });
  expect(trackedPromiseCount(lifecycle)).toBeGreaterThan(0);
  await verifyAuthoredOperations('release-on-close', operations, lifecycle);
  lifecycle.close();
  expect(trackedMapSizes(lifecycle)).toEqual([]);
});

// P2-A (repair 2026-09-03): the interception is still an intrinsic patch — see
// the repair report — but it must not change what Promise.all DOES. It used to
// resolve [] for a non-iterable where the specification rejects, and to throw
// synchronously for null where the specification returns a rejected promise.
it('keeps Promise.all specification behaviour while a flow is open', async () => {
  const lifecycle = new AuthoredFlowLifecycle();
  try {
    expect(Promise.all.name).toBe('all');
    await expect(Promise.all(null as never)).rejects.toBeInstanceOf(TypeError);
    await expect(Promise.all(5 as never)).rejects.toBeInstanceOf(TypeError);
    await expect(Promise.all([Promise.resolve(1), 2])).resolves.toEqual([1, 2]);
  } finally {
    lifecycle.close();
  }
});

/** Every Map/Set the lifecycle graph holds, by size, dropping the empty ones. */
function trackedMapSizes(lifecycle: AuthoredFlowLifecycle): number[] {
  const sizes: number[] = [];
  const visit = (holder: object): void => {
    for (const value of Object.values(holder)) {
      if (value instanceof Map || value instanceof Set) {
        if (value.size > 0) sizes.push(value.size);
      } else if (Array.isArray(value)) {
        if (value.length > 0) sizes.push(value.length);
      } else if (typeof value === 'object' && value !== null) {
        visit(value);
      }
    }
  };
  visit(lifecycle);
  return sizes;
}

function trackedPromiseCount(lifecycle: AuthoredFlowLifecycle): number {
  return trackedMapSizes(lifecycle).reduce((total, size) => total + size, 0);
}
