import { it, expect, vi, beforeEach } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { completeCommunicationDispatch } from '../src/communication/worker.js';
const mocks = vi.hoisted(() => ({
  invoke: undefined as undefined | ((request: { operation: string; values: string[] }) => Promise<unknown>),
  release: vi.fn(async () => {}), close: vi.fn(async () => {}), toolClose: vi.fn(async () => {}),
  ready: vi.fn(async () => ({ reason: 'ready' })), spawn: vi.fn(),
}));
vi.mock('../src/communication/relay.js', () => ({ acquireRelayRuntime: async () => ({
  prefix: 'managed', channel: 'wf-run', close: mocks.close,
  broker: { onEvent: () => () => {}, spawnPty: mocks.spawn }, messaging: {},
}) }));
vi.mock('../src/communication/tools.js', () => ({ openCommunicationTools: async (invoke: typeof mocks.invoke) => {
  mocks.invoke = invoke;
  return { path: '/tmp/test.sock', helperPath: '/tmp/tool.mjs', close: mocks.toolClose };
} }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ready.mockResolvedValue({ reason: 'ready' });
  mocks.spawn.mockImplementation(async () => {
    setTimeout(() => void mocks.invoke!({ operation: 'complete', values: ['done'] }), 5);
    return { name: 'managed-agent', generation: 'generation', release: mocks.release, waitForReady: mocks.ready };
  });
});
function fixture() {
  const client = { stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30000 })),
    stepComplete: vi.fn(async () => ({})), channelReceive: vi.fn(async () => null) };
  const dispatch = { run_id: 'run', step_id: 'agent', attempt: 1, idempotency_key: 'key', pins: {},
    lease_id: 'lease', lease_deadline_ms: Date.now() + 30000, spec: { type: 'agent', cli: 'claude', instruction: '' } } as StepDispatchEvent;
  return { client, execute: () => completeCommunicationDispatch(client as unknown as JournalClient, dispatch,
    { type: 'relayflows.communication.v1', instruction: 'test', incoming: ['peer'], outgoing: [], timeoutMs: 1000 }, '/tmp/data') };
}
it('releases the exact owned identity and runtime before successful completion; never fabricates measured usage', async () => {
  const f = fixture(); await f.execute();
  expect(mocks.release).toHaveBeenCalledWith('Flow communication attempt ended', { deleteIdentity: true });
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.toolClose).toHaveBeenCalledTimes(1);
  expect(f.client.stepComplete).toHaveBeenCalledWith('run', 'agent', 1, 'key', 'success', expect.objectContaining({
    usage: { tokens_in: 0, tokens_out: 0, dollars_unmetered: true }, output: { summary: 'done' },
  }));
});
it('journals readiness failure and still releases all acquired resources', async () => {
  mocks.ready.mockResolvedValue({ reason: 'timeout' });
  const f = fixture(); await f.execute();
  expect(f.client.stepComplete).toHaveBeenCalledWith('run', 'agent', 1, 'key', 'worker_error', expect.objectContaining({ output: { error: 'Communication agent did not become ready: timeout' } }));
  expect(mocks.release).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
