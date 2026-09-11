import type { JournalClient } from '../journal-client.js';

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
