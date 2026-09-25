import { onWorkerFailure } from './worker-lease.js';
import { randomUUID } from 'node:crypto';
import type { JournalClient } from './journal-client.js';
import { AgentWorker } from './worker.js';
import type { KernelRunSpec } from './spec.js';
import { communicationInstruction } from './communication/spec.js';
import { DEFAULT_LOCAL_AGENT_CAPACITY } from './worker-slots.js';

/** A local worker for stream-only steps; no workspace recovery is claimed. */
export async function attachLocalAgent(
  client: JournalClient,
  dataDir?: string,
  onPtyReady?: (path: string) => void,
  requestedStream?: string,
  capacity: number = DEFAULT_LOCAL_AGENT_CAPACITY,
  runRoot?: string,
  declaredStreams: readonly string[] = [],
): Promise<{
  stream: string;
  readonly failure: unknown;
  close(): Promise<void>;
}> {
  // This worker has consumed no messages: its read offsets are zero, including
  // named declarative streams. The kernel retains ownership of dispatch pins
  // and rejects a resume whose required offsets this worker does not hold.
  // No worktree revision is invented.
  const stream = requestedStream ?? `local-agent-${randomUUID()}`;
  const worker = new AgentWorker(client, {
    workerId: stream,
    // More than one: independent agent steps run side by side instead of the
    // second parking behind the first. Authored bodies size their admission to
    // this same number (worker-slots.ts), so they never ask for more.
    capacity,
    dataDir, onPtyReady, runRoot,
    pins: { workspace: [], streams: [...new Set([stream, ...declaredStreams])]
      .map(stream => ({ stream, read_offset: 0 })) },
  });
  let failure: unknown;
  // The cause travels with the close, so the flow's next request names it.
  worker.on('error', onWorkerFailure('local-agent', error => { failure = error; client.close(error); }));
  await worker.attach();
  return {
    stream,
    get failure() { return failure; },
    async close() {
      await worker.close();
    },
  };
}

/** Conversation workers own their streams and registration; do not steal their dispatches. */
export function declaredLocalAgentStreams(spec: KernelRunSpec): string[] {
  return [...new Set(spec.steps.flatMap(step =>
    step.type === 'agent' && !communicationInstruction(step.instruction)
      ? step.surfaces?.streams?.map(({ stream }) => stream) ?? []
      : []))];
}
