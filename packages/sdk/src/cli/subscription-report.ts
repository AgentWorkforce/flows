import { JournalClient } from '../journal-client.js';
import type { SubscriptionInspectResult } from '../protocol.js';
import type { RunExecution } from './run.js';

/** One JSON emission boundary covers authored/declarative run and resume outcomes. */
export async function withSubscriptionMetadata(
  execution: RunExecution,
  inspect: (socket: string, runId: string) => Promise<SubscriptionInspectResult> = inspectSubscriptions,
): Promise<RunExecution> {
  const { report } = execution;
  const rootRunId = report.rootRunId ?? report.runId;
  if (rootRunId === undefined || execution.exitCode === 2) {
    return { ...execution, report: { ...report, subscriptions: [] } };
  }
  try {
    if (report.socketPath === undefined) throw new Error('run report has no daemon socket');
    const { subscriptions } = await inspect(report.socketPath, rootRunId);
    let suspension = report.suspension;
    if (suspension?.kind === 'event_wait') {
      const state = subscriptions.find(item => item.subscriptionId === suspension!.subscriptionId);
      if (state?.state !== 'active' || !Number.isSafeInteger(state.idleAtMs)
        || !Number.isSafeInteger(state.settleMs) || !Number.isSafeInteger(state.deadlineAtMs)) {
        throw new Error('event wait has no active durable timing snapshot');
      }
      suspension = { ...suspension, settleMs: state.settleMs,
        idleAtMs: state.idleAtMs, deadlineAtMs: state.deadlineAtMs };
    }
    return { ...execution, report: { ...report, subscriptions,
      ...(suspension === undefined ? {} : { suspension }) } };
  } catch (error) {
    // Missing authority is not an empty snapshot: Cloud must not close bindings
    // or schedule timers from invented state. Preserve the run's diagnostic,
    // but fail this report instead of presenting a usable suspension/success.
    const { suspension: _suspension, subscriptions: _subscriptions, ...failed } = report;
    return { exitCode: 1, report: { ...failed, ok: false, diagnostics: [
      ...report.diagnostics, { severity: 'failure', kind: 'protocol_error',
        message: `Cannot inspect durable subscriptions: ${error instanceof Error ? error.message : 'unknown error'}` },
    ] } };
  }
}

async function inspectSubscriptions(socket: string, runId: string): Promise<SubscriptionInspectResult> {
  const client = new JournalClient(socket);
  try {
    await client.connect();
    await client.hello('flows-subscription-report');
    return await client.subscriptionInspect({ run_id: runId });
  } finally {
    client.close();
  }
}
