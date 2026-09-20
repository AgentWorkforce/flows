import type { RelayMessaging } from './relay.js';

/** Observer publication never participates in delivery, acknowledgement, or completion. */
export function createProjection(messaging: RelayMessaging, channel: string, runId: string,
  diagnostic = (value: object) => { process.stderr.write(`${JSON.stringify(value)}\n`); }) {
  let ready: Promise<void> | undefined;
  return (message: { text: string; metadata: Record<string, unknown>; idempotencyKey: string }): void => {
    const publish = async () => {
      ready ??= (async () => {
        try { await messaging.channels.create({ name: channel }); }
        catch {
          await messaging.channels.get(channel);
          await messaging.channels.join(channel);
        }
      })().catch(error => { ready = undefined; throw error; });
      await ready;
      await messaging.messages.send({ channel, ...message });
    };
    void publish().catch(() => diagnostic({ kind: 'communication_projection_failed', run_id: runId,
      channel, idempotency_key: message.idempotencyKey,
      message: 'Observer publication failed; the durable conversation continues.' }));
  };
}
