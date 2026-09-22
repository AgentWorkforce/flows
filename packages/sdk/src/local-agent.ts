import { randomUUID } from 'node:crypto';
import type { JournalClient } from './journal-client.js';
import { AgentWorker } from './worker.js';
import { DEFAULT_LOCAL_AGENT_CAPACITY } from './worker-slots.js';

/** A local worker for stream-only steps; no workspace recovery is claimed. */
export async function attachLocalAgent(
  client: JournalClient,
  dataDir?: string,
  onPtyReady?: (path: string) => void,
  requestedStream?: string,
  capacity: number = DEFAULT_LOCAL_AGENT_CAPACITY,
): Promise<{
  stream: string;
  readonly failure: unknown;
  close(): Promise<void>;
}> {
  // A fresh, unconsumed stream has offset zero. The executor declares exactly
  // this stream on its agent steps. No worktree revision is invented.
  const stream = requestedStream ?? `local-agent-${randomUUID()}`;
  const worker = new AgentWorker(client, {
    workerId: stream,
    // More than one: independent agent steps run side by side instead of the
    // second parking behind the first. Authored bodies size their admission to
    // this same number (worker-slots.ts), so they never ask for more.
    capacity,
    dataDir, onPtyReady,
    pins: { workspace: [], streams: [{ stream, read_offset: 0 }] },
  });
  let failure: unknown;
  worker.on('error', error => { failure = error; client.close(); });
  await worker.attach();
  return {
    stream,
    get failure() { return failure; },
    async close() {
      await worker.close();
    },
  };
}
