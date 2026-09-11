import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JournalClient } from './journal-client.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { readCompletedStepOutput } from './authored-step-output.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import { compileSpec, toKernelSpec } from './compile.js';
import { SPEC_SCHEMA_VERSION, type KernelAgentStep } from './spec.js';
import type { StepDispatchEvent } from './protocol.js';
import { withWorkerLease } from './worker-lease.js';
import { checkSlackHelpers } from './slack-preflight.js';
import { atomicJson, readSlackReceipt, receiptPath, slackWriteback, type SlackCall } from './slack-writeback.js';

export function assertSlackCredentials(): void {
  const report = checkSlackHelpers({ header: { tools: { slack: true } }, body() {} });
  if (!report.ok) {
    const diagnostic = report.diagnostics[0]!;
    throw new AuthoredFlowExecutionError(
      diagnostic.kind === 'helper_slack.mount_required' ? diagnostic.kind : 'helper_slack.credential_missing', diagnostic.message);
  }
}

/** Each helper uses the existing agent lease + effect protocol; no new kernel verb. */
export async function runSlackEffect(
  journal: JournalClient, name: string, stepId: string, call: SlackCall,
  dataDir: string, journalSteps: AuthoredFlowJournalStep[],
): Promise<unknown> {
  assertSlackCredentials();
  const stream = `slack-helper-${randomUUID()}`;
  const spec = toKernelSpec(compileSpec({
    version: SPEC_SCHEMA_VERSION, name: `${name}/${stepId}`,
    steps: [{ id: stepId, type: 'agent', instruction: JSON.stringify(call),
      maxIterations: 3, recoveryMode: 'reset',
      surfaces: { streams: [{ stream }], external: ['/slack'] } }],
  }));
  const outcome = await journal.runStart(spec);
  await atomicJson(join(dataDir, 'helper-runs', `${outcome.run_id}.json`), { provider: 'slack' });
  await driveSlackEffect(journal, outcome.run_id, spec.steps[0] as KernelAgentStep, call, dataDir);
  const output = await readCompletedStepOutput(journal, outcome.run_id, stepId, journalSteps);
  return (output as { receipt: unknown }).receipt;
}

/** Recognize only the journaled helper envelope, so ordinary agent runs keep their worker path. */
export async function resumeSlackEffect(journal: JournalClient, runId: string, dataDir: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(runId) || !existsSync(join(dataDir, 'helper-runs', `${runId}.json`))) return false;
  const entries = (await journal.journalRead(runId, 1)).entries as Array<{
    entry_type: string; payload: { spec?: { steps?: KernelAgentStep[] } };
  }>;
  const steps = entries.find(entry => entry.entry_type === 'run.spawned')?.payload.spec?.steps;
  if (steps?.length !== 1) return false;
  const step = steps[0]!;
  if (step.type !== 'agent' || !step.surfaces?.streams?.[0]?.stream.startsWith('slack-helper-')) return false;
  const call = JSON.parse(step.instruction) as SlackCall;
  if (call.type !== 'effect' || call.provider !== 'slack' || !['post', 'dm', 'reply', 'react'].includes(call.verb)) return false;
  const snapshot = await journal.runGet(runId);
  if (snapshot.status === 'completed' || snapshot.status === 'failed') return true;
  assertSlackCredentials();
  await driveSlackEffect(journal, runId, step, call, dataDir);
  return true;
}

async function driveSlackEffect(
  journal: JournalClient, runId: string, step: KernelAgentStep, call: SlackCall, dataDir: string,
): Promise<void> {
  const client = new JournalClient(journal.socketPath);
  const stream = step.surfaces!.streams![0]!.stream;
  const pins = { workspace: [], streams: [{ stream, read_offset: 0 }] };
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Observe early dispatch failures even while attach/run.resume is still pending.
  void completed.catch(() => undefined);
  let executing = false;
  client.on('step.dispatch', (dispatch: StepDispatchEvent) => {
    if (executing || dispatch.run_id !== runId || dispatch.step_id !== step.id) return;
    executing = true;
    void completeSlackDispatch(client, dispatch, call, dataDir).then(resolve, reject);
  });
  client.on('error', reject);
  try {
    await client.connect();
    await client.hello('flows-slack-helper');
    await client.workerAttach(`slack-${randomUUID()}`, ['agent'], pins, 1);
    const outcome = await journal.runResume(runId);
    if (outcome.status === 'completed') return;
    if (outcome.status === 'failed') {
      throw new AuthoredFlowExecutionError('step_failed', `Slack helper run ${runId} ${outcome.status}`, undefined, runId);
    }
    await completed;
  } catch (error) {
    if (error instanceof AuthoredFlowExecutionError) throw error;
    throw new AuthoredFlowExecutionError('step_failed', error instanceof Error ? error.message : 'Slack effect failed', 'worker_error', runId);
  } finally { client.close(); }
}

async function completeSlackDispatch(client: JournalClient, dispatch: StepDispatchEvent, call: SlackCall, dataDir: string): Promise<void> {
  const output = await withWorkerLease(client, dispatch, async signal => {
    const file = receiptPath(dataDir, dispatch.run_id, dispatch.step_id);
    let receipt: unknown;
    await client.performEffect({
      runId: dispatch.run_id, stepId: dispatch.step_id, attempt: dispatch.attempt,
      idempotencyKey: dispatch.idempotency_key, surfacePath: '/slack',
      revisionBefore: 'pending', revisionAfter: `${dispatch.run_id}:${dispatch.step_id}`,
    }, async () => {
      try { receipt = await readSlackReceipt(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        receipt = await slackWriteback(call, dataDir, dispatch.run_id, dispatch.step_id, signal);
        await atomicJson(file, receipt);
      }
      signal.throwIfAborted();
    });
    // Also required after a confirmed election followed by a crash before step.complete.
    if (receipt === undefined) receipt = await readSlackReceipt(file);
    return { ...call, idempotencyKey: `${dispatch.run_id}:${dispatch.step_id}`, receipt };
  });
  await client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt,
    dispatch.idempotency_key, 'success', { output, started_pins: dispatch.pins, end_pins: dispatch.pins,
      effects: [{ surface_path: '/slack', idempotency_key: dispatch.idempotency_key }] });
}
