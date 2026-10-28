import { afterEach, expect, it, vi } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { attachLocalAgent } from '../src/local-agent.js';
import { chainFixture } from './flow-chain-fixture.js';
const fake = vi.hoisted(() => ({
  invoke: undefined as undefined | ((request: { operation: string; values: string[] }) => Promise<unknown>),
  release: vi.fn(async () => {}), shutdown: vi.fn(async () => {}), spawn: vi.fn(), send: vi.fn(),
}));
vi.mock('../src/authored-preflight.js', () => ({ authoredPreflight: () => async (flow: unknown) => ({
  flow, report: { ok: true, diagnostics: [], resolutions: [], gates: [] },
}) }));
vi.mock('../src/communication/relay.js', () => ({ connectLocalBroker: async () => ({
  spawnPty: fake.spawn, sendMessage: fake.send, shutdown: fake.shutdown,
  onEvent: () => () => {}, connectEvents: () => {},
}) }));
vi.mock('../src/communication/skills.js', () => ({ installBrokerSkills: async () => {} }));
vi.mock('../src/communication/tools.js', () => ({ openCommunicationTools: async (invoke: typeof fake.invoke) => {
  fake.invoke = invoke;
  return { path: '/tmp/fake.sock', token: 'fake-token', helperPath: '/tmp/fake.mjs', close: async () => {} };
} }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks(); });
it('journals spawn, message, and release through the authored surface and worker', async () => {
  const fixture = chainFixture(); cleanups.push(() => fixture.close());
  const client = await fixture.connect();
  const worker = await attachLocalAgent(client, fixture.data, undefined, undefined, 2, fixture.root);
  cleanups.push(() => worker.close());
  const complete = (text: string, json: string) => {
    const turn = /complete '([^']+)'/.exec(text)![1]!;
    setTimeout(() => void fake.invoke!({ operation: 'complete', values: [turn, json] }), 1);
  };
  fake.spawn.mockImplementation(async input => {
    complete(input.task, '{"pr":42}');
    return { name: input.name, release: fake.release, waitForReady: async () => ({ reason: 'ready' }) };
  });
  fake.send.mockImplementation(async input => {
    complete(input.text, '{"fixed":true}'); return { event_id: 'event', targets: [input.to] };
  });
  const definition = flow('broker-flow', async f => {
    const agent = await f.agent('implement', { task: 'Open PR', transport: 'broker', cli: 'codex', keepAlive: true });
    expect(JSON.parse(agent.summary)).toEqual({ pr: 42 });
    const reply = await f.message(agent.agentName!, 'Fix', { timeout: '5s' });
    expect(JSON.parse(reply.summary)).toEqual({ fixed: true });
    await f.release(agent.agentName!);
    expect(fake.release).toHaveBeenCalledTimes(1);
    f.done('success');
  });
  const report = await executeAuthoredFlow(definition, client, undefined, {
    flowPath: fixture.flowPath, localAgentStream: worker.stream, dataDir: fixture.data, workerCapacity: 2,
  });
  expect(report.completionReason).toBe('success');
  const agents = report.journalSteps.filter(step => step.id.startsWith('agent-'));
  expect(agents).toHaveLength(3);
  for (const step of agents) {
    const entries = (await client.journalRead(step.runId, 1)).entries;
    expect(entries.some(entry => entry.entry_type === 'step.completed' && entry.payload.completionReason === 'success')).toBe(true);
  }
  await worker.close(); expect(fake.release).toHaveBeenCalledTimes(1);
});

it('runs a named gate on f.message against the broker result', async () => {
  const fixture = chainFixture(); cleanups.push(() => fixture.close());
  const client = await fixture.connect();
  const worker = await attachLocalAgent(client, fixture.data, undefined, undefined, 2, fixture.root);
  cleanups.push(() => worker.close());
  const complete = (text: string, json: string) => {
    const turn = /complete '([^']+)'/.exec(text)![1]!;
    setTimeout(() => void fake.invoke!({ operation: 'complete', values: [turn, json] }), 1);
  };
  fake.spawn.mockImplementation(async input => {
    complete(input.task, '{"pr":42}');
    return { name: input.name, release: fake.release, waitForReady: async () => ({ reason: 'ready' }) };
  });
  fake.send.mockImplementation(async input => {
    complete(input.text, '{"fixed":true}'); return { event_id: 'event', targets: [input.to] };
  });
  const definition = flow('broker-message-gate', async f => {
    const agent = await f.agent('implement', { task: 'Open PR', transport: 'broker', cli: 'codex', keepAlive: true });
    await f.message(agent.agentName!, 'Fix').gate({ type: 'artifact_exists', path: 'result.json' });
    f.done('success');
  });
  await expect(executeAuthoredFlow(definition, client, undefined, {
    flowPath: fixture.flowPath, localAgentStream: worker.stream, dataDir: fixture.data, workerCapacity: 2,
  })).rejects.toThrow(/agent-\d+\.gate/);
  expect(fake.spawn).toHaveBeenCalledTimes(1);
  expect(fake.send).toHaveBeenCalledTimes(1);
});

it.each(['named', 'predicate'] as const)('refuses a retained spawn with a %s gate before allocating a PTY', async gate => {
  const fixture = chainFixture(); cleanups.push(() => fixture.close());
  const client = await fixture.connect();
  const definition = flow('broker-gated', async f => {
    const agent = f.agent('implement', { task: 'Open PR', transport: 'broker', cli: 'codex', keepAlive: true });
    if (gate === 'predicate') await agent.gate(() => false);
    else await agent.gate({ type: 'artifact_exists', path: 'result.json' });
    f.done('success');
  });
  await expect(executeAuthoredFlow(definition, client, undefined, {
    flowPath: fixture.flowPath, localAgentStream: 'fake-local-worker', dataDir: fixture.data,
  })).rejects.toThrow('Retained broker agents do not support gates');
  expect(fake.spawn).not.toHaveBeenCalled();
});
