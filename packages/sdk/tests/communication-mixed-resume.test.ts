import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import { ensureDaemon } from '../src/daemon-lifecycle.js';
import { resumeFlow, socketFor } from '../src/cli/run.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const state = vi.hoisted(() => ({ started: new Set<string>(), ready: Promise.resolve(), release: () => {} }));
vi.mock('../src/communication/preflight.js', () => ({ checkCommunicationEnvironment: () => {}, CommunicationEnvironmentError: class extends Error {} }));
vi.mock('../src/communication/relay.js', () => ({ loadRelayModules: async () => ({}) }));
vi.mock('../src/worker-cli.js', () => ({ runAgentCli: async () => {
  // Ordinary work cannot finish until BOTH conversation peers have capacity.
  await state.ready;
  return { exit_code: 0, stdout_tail: 'ordinary completed', stderr_tail: '' };
} }));
vi.mock('../src/communication/worker.js', () => ({ requireCommunicationCli: () => {},
  completeCommunicationDispatch: async (client: JournalClient, dispatch: StepDispatchEvent) => {
    state.started.add(dispatch.step_id);
    if (state.started.size === 2) state.release();
    await state.ready;
    await client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key,
      'success', { output: { summary: 'peer started concurrently' }, started_pins: dispatch.pins, end_pins: dispatch.pins });
  },
}));

it('resumes mixed ordinary and linked agents through the real daemon without stealing peer capacity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'communication-resume-'));
  const dataDir = join(root, 'data');
  state.started.clear();
  let reject!: (error: Error) => void;
  state.ready = new Promise<void>((yes, no) => { state.release = yes; reject = no; });
  void state.ready.catch(() => {});
  const timeout = setTimeout(() => reject(new Error('ordinary work occupied a conversation worker')), 5000);
  const client = new JournalClient(socketFor(dataDir));
  try {
    expect((await ensureDaemon(dataDir)).kind).toBe('attached');
    await client.connect(); await client.hello('mixed-resume-test');
    const spec = toKernelSpec(compileSpec({ version: '0.1.0', cli: 'test-cli',
      communication: { links: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] },
      steps: ['ordinary1', 'ordinary2', 'a', 'b'].map(id => ({ id, type: 'agent', cli: 'test-cli', instruction: id })),
    }));
    const parked = await client.runStart(spec);
    expect(parked.status).toBe('parked');
    const resumed = await resumeFlow(parked.run_id, dataDir, { localAgent: true, signal: AbortSignal.timeout(8000) });
    expect(resumed.report, JSON.stringify(resumed.report)).toMatchObject({ status: 'completed', completionReason: 'success', completedSteps: 4 });
    expect(state.started).toEqual(new Set(['a', 'b']));
    const entries = (await client.journalRead(parked.run_id, 1)).entries;
    expect(entries.filter(entry => entry.entry_type === 'step.completed')).toHaveLength(4);
  } finally {
    clearTimeout(timeout); state.release(); client.close();
    try { process.kill(JSON.parse(readFileSync(join(dataDir, 'connection.json'), 'utf8')).pid, 'SIGTERM'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 15_000);
