import { createHash } from 'node:crypto';
import { compileSpec, toKernelSpec } from './compile.js';
import type { JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import { withWorkerLease } from './worker-lease.js';
import { snapshotJsonValue } from './json-value.js';

/** Structural subset of Agent Relay's messages.dm; credentials stay in the client. */
export interface ChannelBroker {
  messages: {
    dm(input: {
      to: string;
      text: string;
      idempotencyKey: string;
      metadata: { channel: string; messageId: string };
    }): Promise<unknown>;
  };
}

export interface ChannelPost {
  channel: string;
  to: string;
  text: string;
}

function validatePost(post: ChannelPost, participants: readonly string[]): void {
  if (typeof post.channel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(post.channel)) {
    throw new Error('channel_invalid');
  }
  if (typeof post.to !== 'string' || !post.to.trim() || !participants.includes(post.to)) {
    throw new Error(`channel_participant_unresolved: ${post.to}`);
  }
  if (typeof post.text !== 'string') throw new Error('channel_text_invalid');
}

/** One message boundary per step. Participant resolution precedes journal submission. */
export function channelPostSpec(
  name: string, stepId: string, post: ChannelPost, participants: readonly string[],
) {
  post = snapshotJsonValue(post, 'channel post') as unknown as ChannelPost;
  validatePost(post, participants);
  return toKernelSpec(compileSpec({
    version: SPEC_SCHEMA_VERSION, name,
    steps: [{ id: stepId, type: 'agent',
      instruction: JSON.stringify({ type: 'effect', provider: 'channel', verb: 'post',
        channel: post.channel, to: post.to, text: post.text }),
      maxIterations: 3, recoveryMode: 'reset',
      surfaces: { streams: [{ stream: `channel-${post.channel}` }], external: [`/channel/${post.channel}`] },
    }],
  }));
}

/**
 * Internal post-only proof, for an already provisioned run-scoped broker client.
 * The broker must honor idempotencyKey across worker retries. The application
 * message ID is deliberately distinct from any provider-generated record ID.
 */
export async function completeChannelPost(
  client: JournalClient, dispatch: StepDispatchEvent, broker: ChannelBroker,
  participants: readonly string[],
): Promise<void> {
  const spec = dispatch.spec as { instruction?: string; surfaces?: { external?: string[] } };
  if (dispatch.step_type !== 'agent' || typeof spec.instruction !== 'string') {
    throw new Error('channel_dispatch_invalid');
  }
  const call = JSON.parse(spec.instruction) as ChannelPost & { type: string; provider: string; verb: string };
  if (call.type !== 'effect' || call.provider !== 'channel' || call.verb !== 'post') {
    throw new Error('channel_dispatch_invalid');
  }
  validatePost(call, participants);
  const surfacePath = `/channel/${call.channel}`;
  if (!spec.surfaces?.external?.includes(surfacePath)) throw new Error('channel_surface_undeclared');
  const messageId = createHash('sha256')
    .update(JSON.stringify([dispatch.run_id, dispatch.step_id, call.channel])).digest('hex');
  await withWorkerLease(client, dispatch, async signal => {
    await client.performEffect({
      runId: dispatch.run_id, stepId: dispatch.step_id, attempt: dispatch.attempt,
      idempotencyKey: dispatch.idempotency_key, surfacePath,
      revisionBefore: 'pending', revisionAfter: messageId,
    }, async () => {
      signal.throwIfAborted();
      await broker.messages.dm({ to: call.to, text: call.text, idempotencyKey: messageId,
        metadata: { channel: call.channel, messageId } });
      signal.throwIfAborted();
    });
  });
  // All receipt fields already exist in the journaled spec and stable run identity.
  // A crash after confirm needs neither a local receipt cache nor a broker read.
  await client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt,
    dispatch.idempotency_key, 'success', {
      output: { type: 'effect', provider: 'channel', verb: 'post',
        messageId, channel: call.channel, to: call.to, text: call.text },
      started_pins: dispatch.pins, end_pins: dispatch.pins,
      effects: [{ surface_path: surfacePath, idempotency_key: dispatch.idempotency_key }],
    });
}
