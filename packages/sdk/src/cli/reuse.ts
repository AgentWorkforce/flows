import type { JournalClient } from '../journal-client.js';
import { isReadInterruptionError } from '../journal-read-policy.js';
import type { RunExecution } from './run.js';

/** Count durable facts, including failed executions, across paginated reads. */
export async function reuseSummary(client: JournalClient, runId: string, fromRunId: string): Promise<{
  fromRunId: string; reusedSteps: number; executedSteps: number;
}> {
  const reused = new Set<string>();
  const executed = new Set<string>();
  let fromSeq = 1;
  while (true) {
    const { entries } = await client.journalRead(runId, fromSeq, 1000);
    if (entries.length === 0) break;
    for (const raw of entries) {
      const entry = raw as { seq: number; entry_type: string; step_id?: string; payload: { reused_from?: unknown } };
      if (!Number.isSafeInteger(entry.seq) || entry.seq < fromSeq) throw new Error('invalid journal sequence in reuse summary');
      fromSeq = entry.seq + 1;
      if (entry.step_id === undefined) continue;
      if (entry.entry_type === 'step.attempt.started') executed.add(entry.step_id);
      if (entry.entry_type === 'step.completed' && entry.payload.reused_from !== undefined) reused.add(entry.step_id);
    }
  }
  return { fromRunId, reusedSteps: reused.size, executedSteps: executed.size };
}

/**
 * Add the reuse summary to an already classified run. The summary is an extra
 * journal read after the outcome is known: if it cannot be answered, report
 * that as a warning and keep the classified outcome rather than recasting a
 * finished run as resumable.
 */
export async function attachReuseSummary(execution: RunExecution, client: JournalClient,
  runId: string, fromRunId: string): Promise<RunExecution> {
  // Classification already ended on an unanswered read: the run is resumable and
  // another read would only spend a fresh budget against the same delayed daemon.
  if (execution.report.diagnostics.some(diagnostic =>
    diagnostic.kind === 'daemon_unresponsive' || diagnostic.kind === 'daemon_unreachable')) return execution;
  try {
    execution.report.reuse = await reuseSummary(client, runId, fromRunId);
  } catch (error) {
    if (!isReadInterruptionError(error)) throw error;
    execution.report.diagnostics = [...execution.report.diagnostics, { severity: 'warning', kind: 'reuse_summary_unavailable',
      message: `The run's outcome is final, but the summary of steps reused from ${fromRunId} could not be read: ${error.message}` }];
  }
  return execution;
}
