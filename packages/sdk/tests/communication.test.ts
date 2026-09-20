import { describe, it, expect, vi } from 'vitest';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { communicationInstruction, channelName } from '../src/communication/spec.js';
import { CommunicationSession } from '../src/communication/session.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import type { RelayRuntime } from '../src/communication/relay.js';
const flow = { version: '0.1.0', cli: 'claude', steps: [
  { id: 'a', type: 'agent', instruction: 'design' }, { id: 'b', type: 'agent', instruction: 'review' },
] };
const links = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }];
describe('explicit communication topology', () => {
  it('does not activate for ordinary multi-agent DAGs or empty links', () => {
    const plain = compileSpec(flow);
    expect(compileSpec({ ...flow, communication: { links: [] } })).toEqual(plain);
    expect(plain.steps.every(step => step.type !== 'agent' || !communicationInstruction(step.instruction))).toBe(true);
  });
  it('uses distinct writable surfaces so the kernel can dispatch both agents', () => {
    const [a, b] = toKernelSpec(compileSpec({ ...flow, communication: { links } })).steps;
    if (a?.type !== 'agent' || b?.type !== 'agent') throw Error('not agents');
    expect(communicationInstruction(a.instruction)).toMatchObject({ incoming: ['b'], outgoing: ['b'] });
    expect(a.surfaces?.streams?.map(s => s.stream)).toContain(channelName('a', 'b'));
    expect(a.surfaces?.streams?.some(s => b.surfaces?.streams?.some(t => s.stream === t.stream))).toBe(false);
  });
  it('refuses missing peers, self links, and duplicate edges', () => {
    for (const edges of [[{ from: 'a', to: 'missing' }], [{ from: 'a', to: 'a' }], [links[0], links[0]]])
      expect(() => compileSpec({ ...flow, communication: { links: edges } })).toThrow();
  });
  it('refuses dependency ancestors', () => {
    expect(() => compileSpec({ ...flow, steps: [flow.steps[0], { ...flow.steps[1], dependsOn: ['a'] }],
      communication: { links } })).toThrow(/concurrent/);
  });
});
function fixture() {
  const order: string[] = [];
  const client = {
    channelAppend: vi.fn(async (_input: unknown) => { order.push('append'); return { seq: 1 }; }),
    channelReceive: vi.fn(async () => { order.push('receive'); return { seq: 7, payload: { message: 'proposal', channel: channelName('b', 'a'), offset: 1 } }; }),
    channelAck: vi.fn(async (_input: unknown) => { order.push('ack'); return { seq: 8 }; }),
  };
  const messaging = { messages: {
    direct: vi.fn(async (_input: unknown) => { order.push('direct'); return { id: 'relay-id' }; }),
    send: vi.fn(async () => { order.push('projection'); }),
  } };
  const complete = vi.fn();
  const fatal = vi.fn();
  const dispatch = { run_id: 'run-1', step_id: 'a', attempt: 1, idempotency_key: 'attempt-key' } as StepDispatchEvent;
  const session = new CommunicationSession(client as unknown as JournalClient, dispatch,
    { type: 'relayflows.communication.v1', instruction: '', incoming: ['b'], outgoing: ['b'], timeoutMs: 1000 },
    { prefix: 'run-prefix', channel: 'wf-run-1', messaging } as unknown as RelayRuntime, complete, fatal);
  return { client, messaging, complete, session, order, fatal };
}
describe('journal to managed-agent bridge', () => {
  it('journals sends with the dispatched identity, without bypassing the journal to publish', async () => {
    const f = fixture();
    await f.session.invoke({ operation: 'send', values: ['b', 'proposal-v1', 'hello'] });
    expect(f.client.channelAppend).toHaveBeenCalledWith({ run_id: 'run-1', step_id: 'a', attempt: 1,
      idempotency_key: 'attempt-key', channel: channelName('a', 'b'), message_id: 'proposal-v1', message: 'hello' });
    expect(f.messaging.messages.direct).not.toHaveBeenCalled();
  });
  it('journals delivery before injection, advances only after explicit processing acknowledgement', async () => {
    const f = fixture();
    await f.session.pump(); await f.session.pump();
    expect(f.order).toEqual(['receive', 'direct', 'projection']);
    expect(f.client.channelAck).not.toHaveBeenCalled();
    await expect(f.session.invoke({ operation: 'complete', values: ['done'] })).rejects.toThrow(/Acknowledge/);
    await f.session.invoke({ operation: 'ack', values: ['b', '7'] });
    expect(f.client.channelAck).toHaveBeenCalledWith(expect.objectContaining({ delivery_seq: 7 }));
  });
  it('refuses undeclared peers and forged acknowledgements', async () => {
    const f = fixture();
    await expect(f.session.invoke({ operation: 'send', values: ['outsider', 'x', 'hello'] })).rejects.toThrow();
    await expect(f.session.invoke({ operation: 'ack', values: ['b', '7'] })).rejects.toThrow();
    await f.session.pump();
    await expect(f.session.invoke({ operation: 'ack', values: ['b', '8'] })).rejects.toThrow();
    expect(f.client.channelAck).not.toHaveBeenCalled();
  });
  it('fails the attempt on a journal write error, while malformed local requests remain correctable', async () => {
    const f = fixture();
    await expect(f.session.invoke({ operation: 'ack', values: ['b', '999'] })).rejects.toThrow();
    expect(f.fatal).not.toHaveBeenCalled();
    f.client.channelAppend.mockRejectedValueOnce(new Error('journal unavailable'));
    await expect(f.session.invoke({ operation: 'send', values: ['b', 'v1', 'hello'] })).rejects.toThrow();
    expect(f.fatal).toHaveBeenCalledWith(expect.objectContaining({ message: 'journal unavailable' }));
  });
  it('fails closed when the journal cannot record a delivery', async () => {
    const f = fixture(); f.client.channelReceive.mockRejectedValueOnce(new Error('journal disk full'));
    await expect(f.session.pump()).rejects.toThrow('journal disk full');
    expect(f.messaging.messages.direct).not.toHaveBeenCalled();
  });
  it('reuses the publication key after an ambiguous transport failure', async () => {
    const f = fixture(); f.messaging.messages.direct.mockRejectedValueOnce(new Error('connection reset after publish'));
    await expect(f.session.pump()).rejects.toThrow(); await f.session.pump();
    expect(f.messaging.messages.direct.mock.calls[0]).toEqual(f.messaging.messages.direct.mock.calls[1]);
    expect(f.client.channelAck).not.toHaveBeenCalled();
  });
});
