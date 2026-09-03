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
  const operations: AuthoredFlowOperation<string>[] = [];
  const create = (): AuthoredFlowOperation<string> => {
    const authored = operation(verb, lifecycle, operations.length + 1);
    operations.push(authored);
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
