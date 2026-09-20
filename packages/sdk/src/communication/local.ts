import { randomUUID } from 'node:crypto';
import { JournalClient } from '../journal-client.js';
import { AgentWorker } from '../worker.js';
import type { KernelRunSpec } from '../spec.js';
import { communicationInstruction } from './spec.js';
import { loadRelayModules, relayWorkspaceKey } from './relay.js';
import { requireCommunicationCli } from './worker.js';

export async function attachCommunicationWorkers(spec: KernelRunSpec, socketPath: string, dataDir: string) {
  const steps = spec.steps.filter(step => step.type === 'agent' && communicationInstruction(step.instruction));
  relayWorkspaceKey();
  await loadRelayModules();
  const workers: Array<{ client: JournalClient; worker: AgentWorker }> = [];
  let failure: unknown;
  const close = async () => {
    const outcomes = await Promise.allSettled(workers.map(async ({ client, worker }) => {
      try { await worker.close(); } finally { client.close(); }
    }));
    const rejected = outcomes.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  };
  try {
    for (const step of steps) {
      if (step.type !== 'agent') continue;
      requireCommunicationCli(step.cli ?? spec.cli);
      if (step.surfaces?.workspace?.length) throw new Error('Local communication workers support stream surfaces only');
      const client = new JournalClient(socketPath);
      const worker = new AgentWorker(client, { workerId: `communication-${randomUUID()}`, dataDir,
        pins: { workspace: [], streams: step.surfaces?.streams?.map(({ stream }) => ({ stream, read_offset: 0 })) ?? [] } });
      workers.push({ client, worker });
      worker.on('error', error => { failure = error; client.close(); });
      await client.connect();
      await client.hello('flows-communication');
      await worker.attach();
    }
    return { get failure() { return failure; }, close };
  } catch (error) { await close(); throw error; }
}
