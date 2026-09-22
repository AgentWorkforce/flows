import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli.js';
import { DEFAULT_LOCAL_AGENT_CAPACITY, MAX_LOCAL_AGENT_CAPACITY, WorkerSlots } from '../src/worker-slots.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('WorkerSlots', () => {
  it('holds at most `capacity` at once and admits the rest in arrival order', async () => {
    const slots = new WorkerSlots(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let live = 0;
    let peak = 0;
    const runs = gates.map((gate, index) => slots.run(async () => {
      started.push(index);
      peak = Math.max(peak, ++live);
      await gate.promise;
      live--;
      return index;
    }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve();
    await runs[1];
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve(); gates[2]!.resolve(); gates[3]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('close refuses queued and later calls but lets the running one finish', async () => {
    const slots = new WorkerSlots(1);
    const gate = deferred();
    const started: string[] = [];
    const running = slots.run(async () => { started.push('a'); await gate.promise; return 'a'; });
    const queued = slots.run(async () => { started.push('b'); return 'b'; });
    await Promise.resolve();
    const reason = new Error('body failed');
    slots.close(reason);
    await expect(queued).rejects.toBe(reason);
    await expect(slots.run(async () => 'c')).rejects.toBe(reason);
    gate.resolve();
    expect(await running).toBe('a');
    expect(started).toEqual(['a']);
  });

  it('frees the slot when the work throws', async () => {
    const slots = new WorkerSlots(1);
    await expect(slots.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await slots.run(async () => 'next')).toBe('next');
  });

  it('refuses a capacity that is not an integer from 1 to the ceiling', () => {
    for (const bad of [0, -1, 1.5, MAX_LOCAL_AGENT_CAPACITY + 1, Number.NaN]) {
      expect(() => new WorkerSlots(bad)).toThrow(RangeError);
    }
  });
});

describe('--agent-capacity', () => {
  it('sizes the local workers on run and resume', () => {
    expect(parseCliArgs(['run', '--local-agent', '--agent-capacity', '8', 'flow.yaml']))
      .toMatchObject({ command: 'run', localAgent: true, agentCapacity: 8 });
    expect(parseCliArgs(['resume', '--local-agent', '--agent-capacity', '1', 'run-1']))
      .toMatchObject({ command: 'resume', agentCapacity: 1 });
    expect(parseCliArgs(['run', '--local-agent', 'flow.yaml'])).toMatchObject({ agentCapacity: undefined });
    expect(DEFAULT_LOCAL_AGENT_CAPACITY).toBeGreaterThan(1);
  });

  it('is refused as an invocation when it is not a capacity or has no local worker to size', () => {
    for (const argv of [
      ['run', '--local-agent', '--agent-capacity', '0', 'flow.yaml'],
      ['run', '--local-agent', '--agent-capacity', String(MAX_LOCAL_AGENT_CAPACITY + 1), 'flow.yaml'],
      ['run', '--local-agent', '--agent-capacity', '2.5', 'flow.yaml'],
      ['run', '--local-agent', '--agent-capacity', '0x4', 'flow.yaml'],
      ['run', '--local-agent', '--agent-capacity', 'flow.yaml'],
      ['run', '--local-agent', '--agent-capacity', '2', '--agent-capacity', '3', 'flow.yaml'],
      ['run', '--agent-capacity', '2', 'flow.yaml'],
      ['run', '--cloud', '--agent-capacity', '2', 'flow.yaml'],
      ['check', '--agent-capacity', '2', 'flow.yaml'],
    ]) {
      expect(parseCliArgs(argv), argv.join(' ')).toBeUndefined();
    }
  });
});
