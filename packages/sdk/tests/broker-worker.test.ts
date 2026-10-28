import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { BrokerSessions } from '../src/communication/broker-worker.js';
import { BROKER_TYPE, type BrokerInstruction } from '../src/communication/broker-spec.js';
const fake = vi.hoisted(() => ({
  event: undefined as undefined | ((event: { kind: string; name: string }) => void),
  invoke: undefined as undefined | ((request: { operation: string; values: string[] }) => Promise<unknown>),
  release: vi.fn(async () => {}), shutdown: vi.fn(async () => {}), close: vi.fn(async () => {}),
  ready: vi.fn(async () => ({ reason: 'ready' })), spawn: vi.fn(), send: vi.fn(), install: vi.fn(),
}));
vi.mock('../src/communication/relay.js', () => ({ connectLocalBroker: async () => ({
  spawnPty: fake.spawn, sendMessage: fake.send, shutdown: fake.shutdown, connectEvents: () => {}, onEvent: (callback: typeof fake.event) => { fake.event = callback; return () => {}; },
}) }));
vi.mock('../src/communication/skills.js', () => ({ installBrokerSkills: fake.install }));
vi.mock('../src/communication/tools.js', () => ({ openCommunicationTools: async (invoke: typeof fake.invoke) => {
  fake.invoke = invoke;
  return { path: '/tmp/fake.sock', token: 'fake-token', helperPath: '/tmp/fake.mjs', close: fake.close };
} }));
let sessions: BrokerSessions;
beforeEach(() => {
  vi.clearAllMocks();
  sessions = new BrokerSessions(process.cwd());
  fake.ready.mockResolvedValue({ reason: 'ready' });
  const complete = (text: string) => {
    const turn = /complete '([^']+)'/.exec(text)![1]!;
    setTimeout(() => void fake.invoke!({ operation: 'complete', values: [turn, '{"ok":true}'] }), 1);
  };
  fake.spawn.mockImplementation(async input => {
    complete(input.task);
    return { name: input.name, release: fake.release, waitForReady: fake.ready };
  });
  fake.send.mockImplementation(async input => { complete(input.text); return { event_id: 'event', targets: [input.to] }; });
});
afterEach(async () => sessions.close());
const instruction: BrokerInstruction = { type: BROKER_TYPE, operation: 'spawn', owner: 'root', flow: 'demo', step: 'implement',
  agentName: 'demo-implement-unique', task: 'Implement', skills: ['review-fix-signoff-loop'], channel: 'flow-root', keepAlive: true, timeoutMs: 2000 };
function fixture() {
  const client = { stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })), stepComplete: vi.fn(async (..._args: unknown[]) => ({})) };
  let number = 0;
  return { client, execute: (change: Partial<BrokerInstruction> = {}) => sessions.complete(client as unknown as JournalClient, {
    run_id: `child-${++number}`, step_id: 'agent', attempt: 1, idempotency_key: `key-${number}`, pins: {},
    lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000,
    spec: { type: 'agent', cli: 'codex', model: 'gpt-5.4', instruction: '' },
  } as StepDispatchEvent, { ...instruction, ...change }, '/tmp/flows-broker-tests') };
}
it('spawns with channel/team/metadata/skills, then reuses the retained session for a message', async () => {
  const f = fixture(); await f.execute();
  expect(fake.install).toHaveBeenCalledWith(instruction.skills, 'codex', process.cwd(), expect.any(AbortSignal));
  expect(fake.spawn).toHaveBeenCalledWith(expect.objectContaining({ name: instruction.agentName,
    skipRelayPrompt: false, channels: ['flow-root'], team: 'flow-root', cwd: process.cwd(), model: 'gpt-5.4',
    harnessConfig: expect.objectContaining({ env: expect.objectContaining({ RELAYFLOW_RUN_ID: 'root', RELAYFLOW_FLOW_NAME: 'demo', RELAYFLOW_STEP_NAME: 'implement' }) }),
  }));
  expect(fake.release).not.toHaveBeenCalled();
  await f.execute({ operation: 'message', task: 'Fix review comments' });
  expect(fake.spawn).toHaveBeenCalledTimes(1);
  expect(fake.send).toHaveBeenCalledWith(expect.objectContaining({ to: instruction.agentName, text: expect.stringContaining('Fix review comments') }));
  expect(f.client.stepComplete).toHaveBeenLastCalledWith('child-2', 'agent', 1, 'key-2', 'success', expect.objectContaining({
    output: { completionReason: 'success', summary: '{"ok":true}', artifacts: [], agentName: instruction.agentName },
  }));
  await sessions.close(); expect(fake.release).toHaveBeenCalledTimes(1); expect(fake.shutdown).toHaveBeenCalledTimes(1);
});
it('passes a declared secret into the broker PTY and withholds other delivered secrets', async () => {
  await sessions.close();
  sessions = new BrokerSessions(process.cwd(), {
    OPENAI_API_KEY: 'codex-key', GH_TOKEN: 'repository-secret', OTHER_SECRET: 'granted',
    RELAY_SECRET_ENV_NAMES: '["OPENAI_API_KEY","GH_TOKEN","OTHER_SECRET"]', RELAY_API_KEY: 'broker-key',
  });
  const client = { supportsFeature: () => true, stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
    stepComplete: vi.fn(async () => ({})) };
  await sessions.complete(client as unknown as JournalClient, {
    run_id: 'child-secret', step_id: 'agent', attempt: 1, idempotency_key: 'key-secret', pins: {},
    lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000,
    spec: { type: 'agent', cli: 'codex', instruction: '', secrets: ['OTHER_SECRET'] },
  } as StepDispatchEvent, instruction, '/tmp/flows-broker-tests');
  const env = fake.spawn.mock.calls[0]![0].harnessConfig.env as Record<string, string>;
  expect(env.OTHER_SECRET).toBe('granted');
  expect(env.OPENAI_API_KEY).toBe('codex-key');
  expect(env).not.toHaveProperty('GH_TOKEN');
  expect(env.RELAY_API_KEY).toBe('');
});
it('explicit release is idempotent and later messages fail closed', async () => {
  const f = fixture(); await f.execute(); await f.execute({ operation: 'release' }); await f.execute({ operation: 'release' });
  expect(fake.release).toHaveBeenCalledTimes(1);
  await f.execute({ operation: 'message' });
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error'); expect(fake.send).not.toHaveBeenCalled();
});
it('releases a non-retained agent before reporting success', async () => {
  const f = fixture(); await f.execute({ keepAlive: false });
  expect(fake.release).toHaveBeenCalledTimes(1);
  expect(fake.release.mock.invocationCallOrder[0]).toBeLessThan(f.client.stepComplete.mock.invocationCallOrder[0]!);
});
it('rejects stale, duplicate, and non-JSON completions', async () => {
  const f = fixture(); await f.execute();
  await expect(fake.invoke!({ operation: 'complete', values: ['child-1:agent:1', '{}'] })).rejects.toThrow('stale');
  fake.send.mockImplementationOnce(async input => {
    await expect(fake.invoke!({ operation: 'complete', values: ['child-1:agent:1', '{}'] })).rejects.toThrow('stale');
    await expect(fake.invoke!({ operation: 'complete', values: ['child-2:agent:1', 'not json'] })).rejects.toThrow();
    await fake.invoke!({ operation: 'complete', values: ['child-2:agent:1', '[]'] });
    return { event_id: 'event', targets: [input.to] };
  });
  await f.execute({ operation: 'message' }); expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('success');
});
it('times out bounded messages and releases the session', async () => {
  const f = fixture(); await f.execute(); fake.send.mockResolvedValue({ event_id: 'event', targets: [instruction.agentName] });
  await f.execute({ operation: 'message', timeoutMs: 10 });
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('timeout'); expect(fake.release).toHaveBeenCalledTimes(1);
});
it('refuses missing delivery targets', async () => {
  const f = fixture(); await f.execute(); fake.send.mockResolvedValue({ event_id: 'unsupported_operation', targets: [] });
  await f.execute({ operation: 'message' });
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error'); expect(fake.release).toHaveBeenCalledTimes(1);
});
it('releases retained resources when the journal write fails', async () => {
  const f = fixture(); f.client.stepComplete.mockRejectedValueOnce(new Error('journal unavailable'));
  await expect(f.execute()).rejects.toThrow('journal unavailable');
  expect(fake.release).toHaveBeenCalledTimes(1); expect(fake.close).toHaveBeenCalledTimes(1);
});
it('refuses invalid cwd and failed skills before spawn', async () => {
  const f = fixture(); await f.execute({ cwd: '/this-directory-does-not-exist' }); expect(fake.spawn).not.toHaveBeenCalled();
  fake.install.mockRejectedValueOnce(new Error('unknown canonical skill'));
  await f.execute(); expect(fake.spawn).not.toHaveBeenCalled(); expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error');
});
it('releases on readiness failure', async () => {
  fake.spawn.mockImplementationOnce(async input => ({ name: input.name, release: fake.release, waitForReady: fake.ready }));
  fake.ready.mockResolvedValue({ reason: 'timeout' });
  const f = fixture(); await f.execute(); expect(fake.release).toHaveBeenCalledTimes(1);
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error');
});
it('times out a spawn that never returns and releases a PTY that arrives later', async () => {
  let resolveSpawn: (value: unknown) => void = () => {};
  fake.spawn.mockImplementationOnce(() => new Promise(resolve => { resolveSpawn = resolve; }));
  const f = fixture();
  await f.execute({ timeoutMs: 100 });
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('timeout');
  const lateRelease = vi.fn(async () => {});
  resolveSpawn({ name: 'late', release: lateRelease, waitForReady: fake.ready });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(lateRelease).toHaveBeenCalledWith('Flow broker session ended', { deleteIdentity: true });
  expect(fake.release).not.toHaveBeenCalled();
});
it('times out even when message submission never responds', async () => {
  const f = fixture(); await f.execute(); fake.send.mockImplementationOnce(() => new Promise(() => {}));
  await f.execute({ operation: 'message', timeoutMs: 10 });
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('timeout'); expect(fake.release).toHaveBeenCalledTimes(1);
});
it('retains a failed release for retry instead of acknowledging it as removed', async () => {
  const f = fixture(); await f.execute(); fake.release.mockRejectedValueOnce(new Error('broker unavailable'));
  await f.execute({ operation: 'release' });
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error');
  expect(fake.close).not.toHaveBeenCalled();
  await f.execute({ operation: 'release' });
  expect(fake.release).toHaveBeenCalledTimes(2); expect(fake.close).toHaveBeenCalledTimes(1);
});
it('a replacement worker refuses messages to lost sessions without spawning a replacement', async () => {
  const f = fixture(); await f.execute({ operation: 'message' });
  expect(fake.spawn).not.toHaveBeenCalled(); expect(fake.send).not.toHaveBeenCalled();
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error');
});
it('releases on lease loss without writing a worker-error completion', async () => {
  const { JournalRequestTimeoutError } = await import('../src/journal-client.js');
  const { isLeaseLost } = await import('../src/worker-lease.js');
  fake.spawn.mockImplementationOnce(async input => ({ name: input.name, release: fake.release, waitForReady: fake.ready }));
  const client = { stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 100, lease_ttl_ms: 100 })), stepComplete: vi.fn() };
  client.stepHeartbeat.mockImplementationOnce(async () => ({ lease_deadline_ms: Date.now() + 100, lease_ttl_ms: 100 }));
  client.stepHeartbeat.mockImplementation(async () => { throw new JournalRequestTimeoutError('step.heartbeat', 10); });
  const error = await sessions.complete(client as unknown as JournalClient, {
    run_id: 'child', step_id: 'agent', attempt: 1, idempotency_key: 'key', pins: {},
    lease_id: 'lease', lease_deadline_ms: Date.now() + 100, lease_ttl_ms: 100,
    spec: { type: 'agent', cli: 'codex', instruction: '' },
  } as StepDispatchEvent, instruction, '/tmp/flows-broker-tests').catch(error => error);
  expect(isLeaseLost(error)).toBe(true); expect(client.stepComplete).not.toHaveBeenCalled();
  expect(fake.release).toHaveBeenCalledTimes(1);
});

it('accepts completion even when the PTY exits before the helper response flushes', async () => {
  fake.spawn.mockImplementationOnce(async input => {
    const turn = /complete '([^']+)'/.exec(input.task)![1]!;
    await fake.invoke!({ operation: 'complete', values: [turn, '{}'] });
    fake.event!({ kind: 'agent_exit', name: input.name });
    return { name: input.name, release: fake.release, waitForReady: fake.ready };
  });
  const f = fixture(); await f.execute({ keepAlive: false });
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('success');
});

it('retires an idle exited session before a later message can send', async () => {
  const f = fixture(); await f.execute();
  fake.event!({ kind: 'agent_exit', name: instruction.agentName });
  await f.execute({ operation: 'message' });
  expect(fake.send).not.toHaveBeenCalled();
  expect(fake.release).toHaveBeenCalledTimes(1);
  expect(fake.close).toHaveBeenCalledTimes(1);
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error');
});

it('retries failed idle-exit cleanup without sending to the dead PTY', async () => {
  const f = fixture(); await f.execute();
  fake.release.mockRejectedValueOnce(new Error('broker unavailable'));
  fake.event!({ kind: 'agent_exit', name: instruction.agentName });
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.execute({ operation: 'message' });
  expect(fake.send).not.toHaveBeenCalled();
  expect(fake.release).toHaveBeenCalledTimes(2);
  expect(fake.close).toHaveBeenCalledTimes(1);
  expect(f.client.stepComplete.mock.calls.at(-1)?.[4]).toBe('worker_error');
});
