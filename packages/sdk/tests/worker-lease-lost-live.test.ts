import { afterEach, expect, it, vi } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalProtocolError } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { onWorkerFailure } from '../src/worker-lease.js';
import { chainFixture } from './flow-chain-fixture.js';

afterEach(() => vi.restoreAllMocks());

it.each(['lease_conflict', 'run_terminal'])('reports journal success after completion rejects with %s', async code => {
  const fixture = chainFixture();
  const client = await fixture.connect();
  const worker = new LlmWorker(client, 'lease-race');
  const fatal = vi.fn((error: unknown) => client.close(error));
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  worker.on('error', onWorkerFailure('race', fatal));
  const complete = client.stepComplete.bind(client);
  let completedRun: string | undefined;
  vi.spyOn(client, 'stepComplete').mockImplementation(async (...args) => {
    await complete(...args);
    completedRun = args[0];
    const entries = (await client.journalRead(args[0], 1)).entries;
    for (const entry_type of ['step.completed', 'run.completed']) {
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({
        entry_type, payload: expect.objectContaining({ completionReason: 'success' }),
      })]));
    }
    const error = new JournalProtocolError(code, 'attempt has no active worker lease');
    error.verb = 'step.complete';
    throw error;
  });
  try {
    await worker.attach();
    const handle = flow('lease-race', async f => {
      await f.llm('hello', { model: 'test-model', output: { type: 'object' } });
      f.done('success');
    });
    const result = await executeAuthoredFlow(handle, client, undefined, { flowPath: fixture.flowPath });
    await worker.close();
    expect(completedRun).toBeDefined();
    expect(result.completionReason).toBe('success');
    expect(fatal).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    await worker.close();
    await fixture.close();
  }
}, 30_000);
