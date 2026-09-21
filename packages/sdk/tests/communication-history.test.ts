import { it, expect, vi } from 'vitest';
import { communicationHistory } from '../src/communication/history.js';
import { channelName, type CommunicationInstruction } from '../src/communication/spec.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
const instruction: CommunicationInstruction = { type: 'relayflows.communication.v1', instruction: '', incoming: ['b'], outgoing: ['b'], timeoutMs: 1000 };
it('restores acknowledged conversation on retry without consuming or acknowledging messages', async () => {
  const channel = channelName('b', 'a');
  const journalRead = vi.fn().mockResolvedValueOnce({ entries: [
    { seq: 1, entry_type: 'channel.appended', payload: { channel, offset: 1, message_id: 'v1', message: 'remember me' } },
    { seq: 2, entry_type: 'channel.acknowledged', payload: { channel, offset: 1, consumer: 'a', delivery_seq: 9 } },
    { seq: 3, entry_type: 'channel.appended', payload: { channel: 'unrelated', message: 'private other conversation' } },
    { seq: 4, entry_type: 'channel.appended', payload: { channel, offset: 2, message: 'not yet processed' } },
    { seq: 5, entry_type: 'channel.delivered', payload: { channel, offset: 2, consumer: 'a', message: 'not yet processed' } },
  ] }).mockResolvedValue({ entries: [] });
  const client = { journalRead } as unknown as JournalClient;
  expect(await communicationHistory(client, { attempt: 1 } as StepDispatchEvent, instruction)).toBe('');
  expect(journalRead).not.toHaveBeenCalled();
  const history = await communicationHistory(client, { run_id: 'run', step_id: 'a', attempt: 2 } as StepDispatchEvent, instruction);
  expect(history).toContain('remember me');
  expect(history).toContain('already_processed');
  expect(history).not.toContain('delivery_seq\":9');
  expect(history).not.toContain('private other conversation');
  expect(history).not.toContain('not yet processed');
  expect(history).not.toContain('channel.delivered');
  expect(journalRead).toHaveBeenNthCalledWith(2, 'run', 6, 256);
});
