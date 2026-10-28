import { rmSync } from 'node:fs';
import { flow } from '@relayflows/surface';
import { expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

it('lowers an authored f.run grant by name and leaves the next step ungranted', async () => {
  const path = sockPath();
  const submitted: Array<Record<string, unknown>> = [];
  const steps = new Map<string, Record<string, unknown>>();
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd',
      features: ['step_env', 'step_secret_scoping'] }),
    'run.start': (ctx, params) => {
      const step = (params.spec as { steps: Array<Record<string, unknown>> }).steps[0]!;
      const runId = `child-${steps.size + 1}`;
      submitted.push(step);
      steps.set(runId, step);
      sendResult(ctx, { run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1 });
    },
    'journal.read': (ctx, params) => sendResult(ctx, { entries: [{
      entry_type: 'step.completed', step_id: steps.get(params.run_id as string)!.id,
      payload: { completionReason: 'success', output: { exit_code: 0, stdout_tail: 'ok', stderr_tail: '' } },
    }] }),
  });
  const client = new JournalClient(path);
  const priorToken = process.env.NATIVE_API_TOKEN;
  const priorManifest = process.env.RELAY_SECRET_ENV_NAMES;
  process.env.NATIVE_API_TOKEN = 'private-token';
  process.env.RELAY_SECRET_ENV_NAMES = '["NATIVE_API_TOKEN"]';
  try {
    await client.connect();
    await client.hello('authored-secret-test');
    await executeAuthoredFlow(flow('authored-secret', async f => {
      await f.run('printf first', { secrets: ['NATIVE_API_TOKEN'] });
      await f.run('printf second');
      f.done('success');
    }), client);
    expect(submitted[0]).toMatchObject({ type: 'deterministic', command: 'printf first',
      secrets: ['NATIVE_API_TOKEN'] });
    expect(submitted[1]).toMatchObject({ type: 'deterministic', command: 'printf second' });
    expect(submitted[1]).not.toHaveProperty('secrets');
    expect(JSON.stringify(submitted)).not.toContain('private-token');
  } finally {
    if (priorToken === undefined) delete process.env.NATIVE_API_TOKEN;
    else process.env.NATIVE_API_TOKEN = priorToken;
    if (priorManifest === undefined) delete process.env.RELAY_SECRET_ENV_NAMES;
    else process.env.RELAY_SECRET_ENV_NAMES = priorManifest;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});
