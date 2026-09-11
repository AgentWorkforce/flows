import { randomUUID } from 'node:crypto';
import type { JournalClient } from './journal-client.js';
import { AgentWorker } from './worker.js';

/** A local worker for stream-only steps; no workspace recovery is claimed. */
export async function attachLocalAgent(client: JournalClient, dataDir?: string, onPtyReady?: (path: string) => void): Promise<{
  stream: string;
  readonly failure: unknown;
  close(): Promise<void>;
}> {
  // A fresh, unconsumed stream has offset zero. The executor declares exactly
  // this stream on its agent steps. No worktree revision is invented.
  const stream = `local-agent-${randomUUID()}`;
  const worker = new AgentWorker(client, {
    workerId: stream,
    capacity: 1,
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
