import { onWorkerFailure } from '../worker-lease.js';
import { randomUUID } from 'node:crypto';
import { FLOW_READ_BUDGET_MS } from '../journal-read-policy.js';
import { JournalClient } from '../journal-client.js';
import { AgentWorker } from '../worker.js';
import type { KernelRunSpec } from '../spec.js';
import { channelName, communicationInstruction } from './spec.js';
import { loadRelayModules } from './relay.js';
import { checkCommunicationEnvironment, CommunicationEnvironmentError } from './preflight.js';
import { requireCommunicationCli } from './worker.js';

export async function attachCommunicationWorkers(spec: KernelRunSpec, socketPath: string, dataDir: string,
  environment?: NodeJS.ProcessEnv) {
  const steps = spec.steps.filter(step => step.type === 'agent' && communicationInstruction(step.instruction));
  checkCommunicationEnvironment(spec);
  try { await loadRelayModules(); }
  catch (error) { throw new CommunicationEnvironmentError(error instanceof Error ? error.message : 'Communication runtime could not be loaded.'); }
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
      // History reads on a retried attempt meet the same CPU load as flow reads.
      const client = new JournalClient(socketPath, { readBudgetMs: FLOW_READ_BUDGET_MS });
      const worker = new AgentWorker(client, { workerId: `communication-${randomUUID()}`, dataDir, environment,
        requiredStreams: [channelName(step.id, '$receipts')],
        pins: { workspace: [], streams: step.surfaces?.streams?.map(({ stream }) => ({ stream, read_offset: 0 })) ?? [] } });
      workers.push({ client, worker });
      worker.on('error', onWorkerFailure('communication', error => { failure = error; client.close(); }));
      await client.connect();
      await client.hello('flows-communication');
      await worker.attach();
    }
    return { get failure() { return failure; }, close };
  } catch (error) { await close(); throw error; }
}
