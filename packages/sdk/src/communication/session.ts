import { createHash } from 'node:crypto';
import type { JournalClient } from '../journal-client.js';
import type { StepDispatchEvent } from '../protocol.js';
import type { CommunicationInstruction } from './spec.js';
import { channelName } from './spec.js';
import type { RelayRuntime } from './relay.js';
import type { CommunicationToolRequest } from './tools.js';

/** Journal operations belong to the dispatched worker connection, never the broker. */
export class CommunicationSession {
  private readonly pending = new Map<string, number>();
  private finished = false;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: JournalClient, private readonly dispatch: StepDispatchEvent,
    private readonly spec: CommunicationInstruction, private readonly relay: RelayRuntime,
    private readonly complete: (summary: string) => void,
    private readonly fatal: (error: unknown) => void = () => {}) {}

  private identity(from: string, to: string) {
    const { run_id, step_id, attempt, idempotency_key } = this.dispatch;
    return { run_id, step_id, attempt, idempotency_key, channel: channelName(from, to) };
  }
  private lock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work);
    this.serial = next.catch(() => {});
    return next;
  }
  private async journal<T>(write: () => Promise<T>): Promise<T> {
    try { return await write(); }
    catch (error) { this.fatal(error); throw error; }
  }
  invoke(request: CommunicationToolRequest): Promise<unknown> {
    return this.lock(async () => {
      if (this.finished) throw new Error('Communication session has completed');
      const { operation, values } = request;
      const [peer, id, text] = values;
      if (operation === 'send') {
        if (values.length !== 3 || !peer || !this.spec.outgoing.includes(peer) || !id || !text)
          throw new Error('Use send DECLARED_PEER STABLE_MESSAGE_ID TEXT');
        // Only the kernel deduplicates sends across worker attempts.
        return this.journal(() => this.client.channelAppend({ ...this.identity(this.dispatch.step_id, peer), message_id: id, message: text }));
      }
      if (operation === 'ack') {
        if (values.length !== 2 || !peer || !this.spec.incoming.includes(peer)
          || !Number.isSafeInteger(Number(id)) || this.pending.get(peer) !== Number(id))
          throw new Error('Use ack PEER DELIVERY_SEQ from a received message');
        const result = await this.journal(() => this.client.channelAck({ ...this.identity(peer, this.dispatch.step_id), delivery_seq: Number(id) }));
        this.pending.delete(peer);
        return result;
      }
      if (operation === 'complete') {
        if (values.length !== 1 || !peer) throw new Error('Use complete SUMMARY');
        if (this.pending.size) throw new Error('Acknowledge processed messages before completing');
        this.finished = true;
        // Let the tool response flush before releasing its managed process.
        setTimeout(() => this.complete(peer), 100);
        return { completed: true };
      }
      throw new Error('Unknown communication operation');
    });
  }
  pump(): Promise<void> {
    return this.lock(async () => {
      if (this.finished) return;
      for (const peer of this.spec.incoming) {
        if (this.pending.has(peer)) continue;
        const entry = await this.client.channelReceive(this.identity(peer, this.dispatch.step_id));
        if (!entry) continue;
        const key = createHash('sha256').update(JSON.stringify([
          this.dispatch.run_id, this.dispatch.step_id, this.dispatch.attempt, entry.seq,
        ])).digest('hex');
        const text = `Flow message from ${peer}; delivery_seq=${entry.seq}.\n${JSON.stringify(entry.payload.message)}\nAfter processing, use the flow helper: ack ${peer} ${entry.seq}.`;
        const metadata = { run_id: this.dispatch.run_id, step_id: this.dispatch.step_id, delivery_seq: entry.seq };
        // A successful injection is not a processing acknowledgement.
        await this.relay.messaging.messages.direct({ to: `${this.relay.prefix}-${this.dispatch.step_id}`,
          text, metadata, idempotencyKey: key, mode: 'wait' });
        this.pending.set(peer, entry.seq);
        this.relay.project({
          text: `${peer} -> ${this.dispatch.step_id}: ${JSON.stringify(entry.payload.message)}`,
          metadata, idempotencyKey: `${key}-projection` });
      }
    });
  }
}
