import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runHelperEffect } from '../src/authored-helper-effect.js';
import { AUTHORED_STEP_STREAM } from '../src/authored-step-index.js';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

/**
 * A helper effect is a child run like any other, so its completion is
 * indexed on the root: a serial resume reads that index to see which call
 * holds each ordinal (authored-serial-ordinals.ts).
 */
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('indexes a completed helper effect on the root run', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helper-index-'));
  dirs.push(dataDir);
  vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
  const appended: Array<{ run_id: unknown; stream: unknown; message: unknown }> = [];
  const path = sockPath();
  const server = startLoopback(path, {
    hello: sendOk,
    'run.start': ctx => sendResult(ctx, { run_id: 'helper-run', status: 'running', completion_reason: null, completed_steps: 0 }),
    'worker.attach': ctx => sendResult(ctx, {}),
    // The kernel already holds the completed receipt: the resume reports it.
    'run.resume': ctx => sendResult(ctx, { run_id: 'helper-run', status: 'completed', completion_reason: 'success', completed_steps: 1 }),
    'journal.read': ctx => sendResult(ctx, { entries: [
      { seq: 1, entry_type: 'step.completed', step_id: 'slack-root-1-1',
        payload: { completionReason: 'success', disposition: 'step_done', output: { receipt: { ts: '1' } } } },
      { seq: 2, entry_type: 'run.completed', payload: { completionReason: 'success' } },
    ] }),
    'stream.append': (ctx, params) => {
      appended.push({ run_id: params.run_id, stream: params.stream, message: params.message });
      sendResult(ctx, { offset: appended.length - 1 });
    },
  });
  await once(server, 'listening');
  const journal = new JournalClient(path);
  try {
    await journal.connect();
    await expect(runHelperEffect(journal, 'flow', 'slack-root-1-1',
      { type: 'effect', provider: 'slack', verb: 'post', params: { channel: '#c', text: 'hi' } } as never,
      dataDir, [], 'root-1')).resolves.toEqual({ ts: '1' });
    expect(appended).toContainEqual({ run_id: 'root-1', stream: AUTHORED_STEP_STREAM, message: expect.objectContaining({
      step: 'slack-root-1-1', runId: 'helper-run', state: 'completed', completionReason: 'success',
    }) });
  } finally {
    journal.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
