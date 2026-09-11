import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { completeHelperDispatch } from '../src/yaml-helper-effect.js';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { helperCall } from '../src/yaml-helpers.js';
import { receiptPath } from '../src/slack-writeback.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '1');
  const dataDir = mkdtempSync(join(tmpdir(), 'yaml-effect-'));
  dirs.push(dataDir);
  const spec = toKernelSpec(compileYaml(`version: 0.1.0
steps:
  - id: notify
    slack: {post: {channel: "#test", text: hi}}
`)).steps[0]!;
  if (spec.type !== 'agent') throw new Error('expected agent lowering');
  const call = helperCall(spec)!;
  const dispatch = { run_id: 'run', step_id: 'notify', step_type: 'agent', attempt: 1,
    idempotency_key: 'election', lease_id: 'lease', spec, pins: { workspace: [], streams: [] },
    lease_deadline_ms: Date.now() + 60_000 } as StepDispatchEvent;
  const performEffect = vi.fn(async (_options, execute: () => Promise<void>) => { await execute(); });
  const stepComplete = vi.fn().mockResolvedValue({});
  const client = Object.assign(new EventEmitter(), { performEffect, stepComplete,
    workerAttach: vi.fn().mockResolvedValue({}),
    stepHeartbeat: vi.fn().mockResolvedValue({ lease_deadline_ms: Date.now() + 60_000 }) }) as unknown as JournalClient;
  return { dataDir, call, dispatch, client, performEffect, stepComplete };
}

it('dispatches the compiled helper from the SDK agent worker without a CLI', async () => {
  const f = fixture();
  const worker = new AgentWorker(f.client, { workerId: 'helper-test', dataDir: f.dataDir,
    pins: f.dispatch.pins });
  const errors = vi.fn();
  worker.on('error', errors);
  await worker.attach();
  try {
    f.client.emit('step.dispatch', f.dispatch);
    await vi.waitFor(() => expect(f.stepComplete).toHaveBeenCalledTimes(1));
    expect(errors).not.toHaveBeenCalled();
    expect(f.performEffect).toHaveBeenCalledWith(expect.objectContaining({ surfacePath: '/slack' }), expect.any(Function));
  } finally { await worker.close(); }
});

it('records the provider effect and recovers its receipt after a crash before completion', async () => {
  const f = fixture();
  f.stepComplete.mockRejectedValueOnce(new Error('crash before completion'));
  await expect(completeHelperDispatch(f.client, f.dispatch, f.call, f.dataDir)).rejects.toThrow('crash before completion');
  const receipt = JSON.parse(readFileSync(receiptPath(f.dataDir, 'run', 'notify'), 'utf8'));
  expect(receipt).toMatchObject({ channel: '#test', ts: 'mock-notify' });
  // A confirmed election skips provider I/O. The durable receipt still completes the step.
  f.performEffect.mockImplementationOnce(async () => {});
  vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '0');
  await completeHelperDispatch(f.client, f.dispatch, f.call, f.dataDir);
  expect(f.stepComplete).toHaveBeenLastCalledWith('run', 'notify', 1, 'election', 'success',
    expect.objectContaining({ output: { ...f.call, idempotencyKey: 'run:notify', receipt },
      effects: [{ surface_path: '/slack', idempotency_key: 'election' }] }));
});

it('reuses a saved receipt if the process died before effect confirmation', async () => {
  const f = fixture();
  f.performEffect.mockImplementationOnce(async (_options, execute) => {
    await execute();
    throw new Error('crash before confirmation');
  });
  await expect(completeHelperDispatch(f.client, f.dispatch, f.call, f.dataDir)).rejects.toThrow('crash before confirmation');
  expect(f.stepComplete).not.toHaveBeenCalled();
  vi.stubEnv('RELAYFLOWS_SLACK_MOCK', '0');
  await completeHelperDispatch(f.client, f.dispatch, f.call, f.dataDir);
  expect(f.stepComplete).toHaveBeenCalledTimes(1);
});

it('does not report success when the effect election fails', async () => {
  const f = fixture();
  f.performEffect.mockRejectedValueOnce(new Error('journal write failed'));
  await expect(completeHelperDispatch(f.client, f.dispatch, f.call, f.dataDir)).rejects.toThrow('journal write failed');
  expect(f.stepComplete).not.toHaveBeenCalled();
});
