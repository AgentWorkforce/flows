import { describe, expect, it } from 'vitest';
import {
  AuthoredFlowOperation,
  verifyAuthoredOperations,
} from '../src/authored-flow-operation.js';

const verbs = ['run', 'llm', 'agent'] as const;

function operation(verb: string): AuthoredFlowOperation<string> {
  return new AuthoredFlowOperation(
    `${verb}-1`,
    verb,
    () => undefined,
    async () => `${verb}-result`,
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe.each(verbs)('authored %s operation lifecycle', (verb) => {
  it('refuses Promise.withResolvers callbacks as proof of await', async () => {
    const deferred = Promise.withResolvers<string>();
    const authored = operation(verb);
    authored.step.then(deferred.resolve, deferred.reject);
    await settle();

    await expect(verifyAuthoredOperations(`native-resolver-${verb}`, [authored]))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });

  it('refuses an ignored Promise.resolve assimilation', async () => {
    const authored = operation(verb);
    void Promise.resolve(authored.step);
    await settle();

    await expect(verifyAuthoredOperations(`ignored-resolve-${verb}`, [authored]))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });

  it('refuses an ignored Promise.all assimilation', async () => {
    const authored = operation(verb);
    void Promise.all([authored.step]);
    await settle();

    await expect(verifyAuthoredOperations(`ignored-all-${verb}`, [authored]))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });

  it('retains a nested callback rejection outside the root thenable', async () => {
    const authored = operation(verb);
    await Promise.resolve(authored.step)
      .then(() => { throw new Error('nested callback was handled and forgotten'); })
      .catch(() => undefined)
      .finally(() => undefined);

    await expect(verifyAuthoredOperations(`nested-callback-${verb}`, [authored]))
      .rejects.toMatchObject({ code: 'operation_callback_failed' });
  });

  it('refuses callback chaining when Function.prototype.toString is forged', async () => {
    const authored = operation(verb);
    const originalToString = Function.prototype.toString;
    Function.prototype.toString = () => 'function () { [native code] }';
    try {
      authored.step.then(() => undefined, () => undefined);
      await settle();
    } finally {
      Function.prototype.toString = originalToString;
    }

    await expect(verifyAuthoredOperations(`forged-callback-${verb}`, [authored]))
      .rejects.toMatchObject({ code: 'unawaited_step' });
  });
});
