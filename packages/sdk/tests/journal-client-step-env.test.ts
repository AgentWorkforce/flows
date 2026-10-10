import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { HELLO_SPEC, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

// F1: a shared daemon spawns `f.run` steps in the environment of the CLI that
// started it. The client sends its own environment on run.start / run.resume
// so each run's steps get THAT run's env -- but only to a daemon that lists
// `step_env`, because an older one refuses unknown params outright.
it.each([
  ['a daemon that predates the feature', undefined, false],
  ['a daemon that advertises it', ['step_env'], true],
] as const)('sends the step env only to %s', async (_name, features, sent) => {
  const path = sockPath();
  const received: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', ...(features === undefined ? {} : { features }) }),
    'run.start': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
    'run.resume': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  process.env.FLOWS_STEP_ENV_PROBE = 'from-this-cli';
  try {
    await client.connect();
    await client.hello('feature-gate');
    await client.runStart(HELLO_SPEC);
    await client.runResume('run-01');
    expect(received).toHaveLength(2);
    for (const params of received) {
      if (sent) expect((params['env'] as Record<string, string>)['FLOWS_STEP_ENV_PROBE']).toBe('from-this-cli');
      else expect(params).not.toHaveProperty('env');
    }
  } finally {
    delete process.env.FLOWS_STEP_ENV_PROBE;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});
