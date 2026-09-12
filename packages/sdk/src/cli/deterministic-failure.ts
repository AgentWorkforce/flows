import type { StepFailedDetails } from '../failure-kinds.js';
import type { JournalClient } from '../journal-client.js';

const STDERR_TAIL_BYTES = 1_024;

/** Read completion evidence through the existing protocol, including later pages. */
export async function deterministicFailureDetails(
  client: JournalClient,
  runId: string,
): Promise<StepFailedDetails | undefined> {
  const snapshot = await client.runGet(runId);
  if (!Object.values(snapshot.steps).some(step => step.type === 'deterministic')) return undefined;
  let fromSeq = 1;
  const failures = new Map<string, StepFailedDetails>();
  while (true) {
    const { entries } = await client.journalRead(runId, fromSeq, 100);
    if (entries.length === 0) break;
    for (const raw of entries) {
      const entry = record(raw);
      const seq = entry?.['seq'];
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < fromSeq) {
        throw new Error('invalid journal sequence in command failure inspection');
      }
      fromSeq = seq + 1;
      const stepId = entry?.['step_id'];
      if (entry?.['entry_type'] !== 'step.completed' || typeof stepId !== 'string'
        || snapshot.steps[stepId]?.type !== 'deterministic') continue;
      // A later completion supersedes an earlier failed attempt.
      failures.delete(stepId);
      const payload = record(entry['payload']);
      // Post-#292 the kernel preserves the captured `{exit_code, stdout_tail,
      // stderr_tail}` in `output` on failed completions; prefer it. Fall back
      // to `trajectory_tail` for journal records emitted before that fix.
      const output = record(payload?.['output']) ?? record(payload?.['trajectory_tail']);
      const exitCode = output?.['exit_code'];
      if (payload?.['disposition'] !== 'step_done' || payload['completionReason'] === 'success'
        || typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode === 0) continue;
      failures.set(stepId, {
        stepId,
        exitCode,
        stderrTail: stderrTail(output?.['stderr_tail']),
        hint: `flows replay ${shellQuote(runId)} --at ${shellQuote(stepId)}`,
      });
    }
  }
  return [...failures.values()].at(-1);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function stderrTail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - STDERR_TAIL_BYTES);
  // Drop a partial leading code point, avoiding replacement-byte expansion.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  // Preserve tabs/newlines; replace binary controls (including ESC and CR),
  // C1 controls and Unicode formatting controls without growing the excerpt.
  return bytes.subarray(start).toString('utf8')
    .replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' || character === '\t' ? character : '?');
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) && !value.startsWith('-')
    ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
