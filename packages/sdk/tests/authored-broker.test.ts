import { expect, it, vi } from 'vitest';
import { authoredBroker } from '../src/authored-broker.js';
import { brokerAgentName, brokerInstruction } from '../src/communication/broker-spec.js';
import { toKernelSpec } from '../src/compile.js';
import type { StepSpec } from '../src/spec.js';
function setup(owner = 'root') {
  const run = vi.fn(async (step: StepSpec) => {
    const kernel = toKernelSpec({ version: '0.1.0', name: 'demo', steps: [step] });
    expect(kernel.steps[0]?.type).toBe('agent');
    expect(kernel.steps[0]).not.toHaveProperty('transport');
    const broker = step.type === 'agent' ? brokerInstruction(step.instruction)! : undefined!;
    return { completionReason: 'success', summary: '{"ok":true}', artifacts: [], agentName: broker.agentName };
  });
  return { run, broker: authoredBroker({ name: 'My flow!' }, owner, 'local-worker', run) };
}
it('lowers broker options into an agent instruction and preserves the JSON summary', async () => {
  const { broker, run } = setup();
  const result = await broker.agent('agent-0', 'Implement #42', { transport: 'broker', task: 'Implement', cli: 'codex',
    cwd: '/external/worktree', keepAlive: true, skills: ['review-fix-signoff-loop'] });
  expect(result.summary).toBe('{"ok":true}');
  const step = run.mock.calls[0]![0];
  expect(step).toMatchObject({ type: 'agent', timeoutMs: 3_600_000, transportRetries: 0,
    surfaces: { streams: [{ stream: 'local-worker' }] } });
  expect(brokerInstruction((step as { instruction: string }).instruction)).toMatchObject({
    cwd: '/external/worktree', channel: 'flow-root', owner: 'root', flow: 'My flow!', step: 'Implement #42',
  });
  await broker.message('agent-1', result.agentName!, 'Fix', { timeout: '5s' });
  expect(run.mock.calls[1]![0]).toMatchObject({ timeoutMs: 5000 });
  await broker.release('agent-2', result.agentName!);
  await broker.release('agent-3', result.agentName!);
  expect(run).toHaveBeenCalledTimes(4);
});
it('names are sanitized, stable on replay, distinct across runs and duplicate display names', () => {
  const name = brokerAgentName('Flow / 🚀', 'Step 42', 'root', 'agent-1');
  expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  expect(brokerAgentName('Flow / 🚀', 'Step 42', 'root', 'agent-1')).toBe(name);
  expect(brokerAgentName('Flow / 🚀', 'Step 42', 'other', 'agent-1')).not.toBe(name);
  expect(brokerAgentName('Flow / 🚀', 'Step 42', 'root', 'agent-2')).not.toBe(name);
});
it('only accepts retained agents created by this flow', async () => {
  const { broker, run } = setup();
  await expect(broker.message('agent-1', 'someone-else', 'Fix')).rejects.toThrow('No retained');
  await expect(broker.release('agent-1', 'someone-else')).rejects.toThrow('No retained');
  expect(run).not.toHaveBeenCalled();
});
it('carries declared secrets onto spawn, message, and release', async () => {
  const { broker, run } = setup();
  const result = await broker.agent('agent-0', 'implement', { transport: 'broker', task: 'Implement', cli: 'codex',
    keepAlive: true, secrets: ['GH_TOKEN'] }, undefined, ['GH_TOKEN']);
  expect(run.mock.calls[0]![0]).toMatchObject({ secrets: ['GH_TOKEN'] });
  await broker.message('agent-1', result.agentName!, 'Fix');
  expect(run.mock.calls[1]![0]).toMatchObject({ secrets: ['GH_TOKEN'] });
  await broker.release('agent-2', result.agentName!);
  expect(run.mock.calls[2]![0]).toMatchObject({ secrets: ['GH_TOKEN'] });
});
it('refuses retained sessions without a local worker pin', async () => {
  const run = vi.fn();
  const broker = authoredBroker({ name: 'demo' }, 'root', undefined, run);
  await expect(broker.agent('agent-0', 'worker', { transport: 'broker', task: 'Work', keepAlive: true }))
    .rejects.toThrow('local agent worker stream');
  expect(run).not.toHaveBeenCalled();
});
it.each([
  { skills: ['../unsafe'] }, { keepAlive: 'yes' }, { channel: 'bad channel' },
  { resume: 'previous' }, { maxIterations: 2 }, { transportRetries: 1 }, { cwd: '' },
])('refuses unsupported or malformed options before admission: %j', async options => {
  const { broker, run } = setup();
  await expect(broker.agent('agent-0', 'worker', { transport: 'broker', task: 'Work', ...options } as any)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
