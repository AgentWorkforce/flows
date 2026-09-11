import { createHash, randomUUID } from 'node:crypto';
import { compileSpec, toKernelSpec } from './compile.js';
import { invokePlugin, type LoadedPlugin } from './plugin-loader.js';
import type { PluginVerb } from './plugin-manifest.js';
import type { AuthoredBudget } from './authored-budget.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import type { JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import { readCompletedStepOutput } from './authored-step-output.js';
import { withWorkerLease } from './worker-lease.js';

export class PluginStepError extends AuthoredFlowExecutionError {
  constructor(readonly diagnostic: string, runId: string) {
    super('step_failed', diagnostic, 'worker_error', runId);
  }
}

/** Helpers lower to an existing agent effect, never a fourth kernel primitive.
 * The Plugin receipt lives in step.completed.output: { type, input, output, ... }.
 * A private stream routes the step to this short-lived SDK worker exclusively.
 */
export async function runPluginEffect(
  journal: JournalClient, flowName: string, id: string, plugin: LoadedPlugin, verb: PluginVerb,
  args: unknown, journalSteps: AuthoredFlowJournalStep[], budget: AuthoredBudget,
): Promise<unknown> {
  const server = verb.namespace;
  const tool = verb.method;
  const idempotencyKey = `plugin:${server}:${tool}:${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`;
  const surfacePath = `/plugins/${pathPart(server)}/${pathPart(tool)}`;
  const stream = `plugin-worker-${randomUUID()}`;
  const instruction = JSON.stringify({ type: 'effect', server, tool, input: args });
  const peer = journal.createPeer();
  let diagnostic: string | undefined;
  let settled!: () => void;
  let failed!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => { settled = resolve; failed = reject; });
  void completed.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  let dispatchExpired = false;
  const dispatch = (event: StepDispatchEvent): void => {
    if (dispatchExpired) return;
    const dispatched = event.spec as { instruction?: string; surfaces?: { streams?: { stream: string }[] } };
    if (event.step_id !== id || event.step_type !== 'agent' || work !== undefined
      || dispatched?.instruction !== instruction
      || !dispatched.surfaces?.streams?.some(pin => pin.stream === stream)) {
      failed(new Error('Plugin worker received an unexpected dispatch'));
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    work = execute(event);
    void work.then(settled, failed);
  };
  async function execute(event: StepDispatchEvent): Promise<void> {
    const receipt = { type: 'effect' as const, plugin: plugin.manifest.name, version: plugin.manifest.version,
      namespace: server, method: tool, input: args, idempotencyKey: event.idempotency_key };
    let output: unknown;
    let confirmed = false;
    try {
      // Renew the worker lease while the Plugin tool is in flight. Without this,
      // a tool that runs longer than the initial lease loses ownership and
      // the write-back path fails — see worker-lease.ts for the renewal contract.
      confirmed = await withWorkerLease(peer, event, async () => {
        return peer.performEffect({
          runId: event.run_id, stepId: id, attempt: event.attempt, idempotencyKey: event.idempotency_key,
          surfacePath, revisionBefore: 'pending', revisionAfter: idempotencyKey,
        }, async () => {
          try { output = await invokePlugin(plugin, verb, args, event.idempotency_key); }
          catch { diagnostic = 'plugin_execution_failed'; throw new PluginExecutionFailure(); }
        });
      });
      // A confirmed election without its receipt is an interrupted writeback,
      // not a successful result we may invent or a call we may safely repeat.
      if (!confirmed) throw new Error('plugin_result_unavailable');
    } catch (error) {
      if (error instanceof PluginExecutionFailure) diagnostic = 'plugin_execution_failed';
      else if (error instanceof Error && error.message === 'plugin_result_unavailable') diagnostic = error.message;
      else throw error; // Journal failures remain fail-closed, never provider errors.
    }
    await peer.stepComplete(event.run_id, id, event.attempt, event.idempotency_key,
      diagnostic === undefined ? 'success' : 'worker_error', {
        output: { ...receipt, output: output ?? null, ...(diagnostic ? { diagnostic } : {}) },
        started_pins: event.pins, end_pins: event.pins,
        ...(diagnostic ? { trajectory_tail: { ...receipt, diagnostic } } : {}),
        effects: confirmed ? [{ surface_path: surfacePath, idempotency_key: event.idempotency_key }] : [],
      });
  }
  let childRunId: string | undefined;
  async function cancelChildRun(): Promise<void> {
    const runId = childRunId;
    childRunId = undefined;
    if (runId !== undefined) {
      try { await journal.runCancel(runId); } catch { /* fail-open on cleanup */ }
    }
  }
  const deadlineError = new Error('Plugin worker dispatch deadline exceeded');
  let finishDeadline!: () => void;
  const deadline = new Promise<void>((resolve, reject) => {
    finishDeadline = resolve;
    // One deadline covers connection, initialization, run creation and dispatch.
    timer = setTimeout(() => {
      dispatchExpired = true;
      failed(deadlineError);
      reject(deadlineError);
    }, 30_000);
  });
  try {
    await Promise.race([peer.connect(), deadline]);
    await Promise.race([peer.hello('flows-plugin'), deadline]);
    peer.on('step.dispatch', dispatch);
    await Promise.race([peer.workerAttach(stream, ['agent'], { workspace: [], streams: [{ stream, read_offset: 0 }] }, 1), deadline]);
    const spec = toKernelSpec(compileSpec({ version: SPEC_SCHEMA_VERSION, name: `${flowName}/${id}`,
      steps: [{ id, type: 'agent', instruction,
        surfaces: { streams: [{ stream }], external: [surfacePath] }, maxIterations: 1 }],
    }));
    return await Promise.race([budget.execute(journal, spec, async outcome => {
      childRunId = outcome.run_id;
      // run.start may answer after the deadline and the outer cleanup.
      if (dispatchExpired) await cancelChildRun();
      await completed;
      if (diagnostic !== undefined) {
        try { await readCompletedStepOutput(journal, outcome.run_id, id, journalSteps); }
        catch (error) {
          if (!(error instanceof AuthoredFlowExecutionError) || error.code !== 'step_failed') throw error;
          throw new PluginStepError(diagnostic, outcome.run_id);
        }
      }
      const receipt = await readCompletedStepOutput(journal, outcome.run_id, id, journalSteps) as { output: unknown };
      return receipt.output;
    }), deadline]);
  } finally {
    clearTimeout(timer);
    finishDeadline();
    peer.off('step.dispatch', dispatch);
    // If the dispatch deadline fired we started a child run that will never
    // be worked -- cancel it so its journal doesn't stay indeterminate.
    // Best-effort: the parent flow already surfaced the deadline via the
    // rejected `completed` promise, so a cancel error here must not mask it.
    if (dispatchExpired) await cancelChildRun();
    peer.close();
    await work?.catch(() => undefined);
  }
}

function pathPart(value: string): string {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

class PluginExecutionFailure extends Error {}
