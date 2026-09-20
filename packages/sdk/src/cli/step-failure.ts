import { join } from 'node:path';
import { DEFAULT_DATA_DIR } from '../daemon-connection.js';
import type { StepFailedDetails } from '../failure-kinds.js';
import type { JournalClient } from '../journal-client.js';

const TAIL_BYTES = 1_024;

/**
 * Read what a failed step left in the journal — for any step type.
 *
 * This was `deterministicFailureDetails`, and its first act was to return
 * `undefined` for any run without a `deterministic` step. That is every
 * `f.agent` and `f.llm` step, because each authored worker call runs as its
 * own single-step kernel run (authored-worker-step.ts). So a failed agent
 * reached the terminal carrying nothing but its taxonomy label — the run said
 * `step_failed` and discarded every account of why, which is the whole reason
 * a local agent failure was undiagnosable.
 *
 * The two step families leave their evidence in different fields, because the
 * kernel preserves `output` on a failed completion only for deterministic
 * steps (`preserve_failure_output`, relayflowd-core/src/machine.rs). For an
 * agent or llm step the worker's `{exit_code, stdout_tail, stderr_tail}` is
 * nulled out of `output` and survives only as the bounded render the daemon
 * captured into `verification.detail` (`worker_failure_detail`,
 * relayflowd/src/engine/remote.rs). Both are read, in that order, and the
 * daemon's render is re-parsed when it carries that same shape: an exit code
 * the daemon stringified on its way into the journal is still an exit code,
 * and printing it as one is the difference between a diagnosis and a blob.
 */
export async function stepFailureDetails(
  client: JournalClient,
  runId: string,
): Promise<StepFailedDetails | undefined> {
  const snapshot = await client.runGet(runId);
  let fromSeq = 1;
  const failures = new Map<string, StepFailedDetails>();
  // `runGet`'s `StepSnapshot` carries only `type`, `state` and an optional
  // lease deadline — neither the attempt number nor the attempt budget. Both
  // are journal facts: the envelope's `attempt` counts the attempt, and
  // `step.attempt.started` records the `max_iterations` the kernel is
  // enforcing (relayflowd-core/src/entry.rs `AttemptStartedPayload`). They are
  // collected on the same walk and reported only when the journal held them.
  const budgets = new Map<string, number>();
  const transportBudgets = new Map<string, number>();
  while (true) {
    const { entries } = await client.journalRead(runId, fromSeq, 100);
    if (entries.length === 0) break;
    for (const raw of entries) {
      const entry = record(raw);
      const seq = entry?.['seq'];
      if (entry === undefined || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < fromSeq) {
        throw new Error('invalid journal sequence in step failure inspection');
      }
      fromSeq = seq + 1;
      const stepId = entry['step_id'];
      if (typeof stepId !== 'string') continue;
      if (entry['entry_type'] === 'step.attempt.started') {
        const maxIterations = record(entry['payload'])?.['max_iterations'];
        if (typeof maxIterations === 'number' && Number.isSafeInteger(maxIterations) && maxIterations > 0) {
          budgets.set(stepId, maxIterations);
        }
        const transportRetries = record(entry['payload'])?.['max_transport_retries'];
        if (typeof transportRetries === 'number' && Number.isSafeInteger(transportRetries) && transportRetries >= 0) {
          transportBudgets.set(stepId, transportRetries);
        }
        continue;
      }
      if (entry['entry_type'] !== 'step.completed') continue;
      // A later completion supersedes an earlier failed attempt.
      failures.delete(stepId);
      const payload = record(entry['payload']);
      if (payload === undefined) continue;
      const completionReason = payload['completionReason'];
      // A terminal completion that is not a success is the failure, whatever
      // its step type. The old predicate also demanded a non-zero `exit_code`,
      // which no agent completion carries and which a deterministic step that
      // exits 0 and then fails its gate does not carry either — both were
      // silently skipped.
      if (payload['disposition'] !== 'step_done'
        || typeof completionReason !== 'string' || completionReason === 'success') continue;
      const stepType = snapshot.steps[stepId]?.type;
      const attempt = entry['attempt'];
      const maxIterations = budgets.get(stepId);
      const transportRetries = transportBudgets.get(stepId);
      failures.set(stepId, {
        stepId,
        completionReason,
        ...(stepType === undefined ? {} : { stepType }),
        ...(typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt > 0 ? { attempt } : {}),
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(transportRetries === undefined ? {} : { transportRetries }),
        ...evidence(payload),
      });
    }
  }
  return [...failures.values()].at(-1);
}

/**
 * The evidence half of a `step_failed` diagnostic; `renderInspection` adds the
 * rest. Each field is printed only when the journal actually carried it — an
 * agent step has no exit code to report, and inventing `exit=undefined` (which
 * is what the deterministic-only version printed for one) is worse than
 * silence on that field.
 *
 * `attempt=N/M` is here for `retries_exhausted`, which is the kernel's terminal
 * reason for "the attempt budget was consumed" (kernel/DESIGN.md) and is
 * accurate kernel vocabulary that reads in English as though retries happened.
 * A deterministic step gets the default budget of one, so a single failed
 * attempt with no retry at all terminates as `retries_exhausted`. The
 * vocabulary does not change (AGENTS.md rule 7); printing the facts beside it
 * stops it being misread. Unknown values are omitted rather than defaulted —
 * an absent budget must not be reported as one attempt.
 *
 * Lives next to `StepFailedDetails`'s extractor rather than in `cli/run.ts` so
 * the authored `f.run` path can render the same grammar without importing the
 * run lifecycle (which would be a cycle).
 */
export function renderStepEvidence(details: StepFailedDetails): string {
  return ` Step ${JSON.stringify(details.stepId)}`
    + (details.stepType === undefined ? '' : ` (${details.stepType})`)
    + ` completionReason: ${details.completionReason}`
    + renderAttempt(details)
    + (details.transportRetries === undefined ? '' : ` transportRetries=${details.transportRetries}`)
    + (details.exitCode === undefined ? '' : ` exit=${details.exitCode}`)
    + (details.signal === undefined ? '' : ` signal=${details.signal}`)
    + (details.transportCause === undefined ? '' : ` transport=${details.transportCause}`)
    + (details.transportPhase === undefined ? '' : ` phase=${details.transportPhase}`)
    + (details.errorCode === undefined ? '' : ` error_code=${details.errorCode}`)
    + (details.retryableTransport === undefined ? '' : ` retryable=${details.retryableTransport}`)
    + '.'
    + (details.detail === undefined ? '' : `\nDetail: ${details.detail}`)
    + (details.stdoutTail ? `\nStdout (last 1,024 bytes):\n${details.stdoutTail}` : '')
    + (details.stderrTail ? `\nStderr (last 1,024 bytes):\n${details.stderrTail}` : '')
    + (details.transcriptPath === undefined ? '' : `\nTranscript: ${details.transcriptPath}`);
}

function renderAttempt(details: StepFailedDetails): string {
  if (details.attempt === undefined) return '';
  return ` attempt=${details.attempt}`
    + (details.maxIterations === undefined ? '' : `/${details.maxIterations}`);
}

/** The `Inspect:`/`Journal:` tail every `step_failed` message ends with. */
export function renderInspection(where: { hint?: string; journalPath?: string }): string {
  if (where.hint === undefined) return '';
  return `\nInspect: ${where.hint}`
    + (where.journalPath === undefined ? '' : `\nJournal: ${where.journalPath}`);
}

/**
 * Where to look, derived from the run id and data dir ALONE.
 *
 * Deliberately independent of the journal read: a failure whose evidence could
 * not be read, or a failure shape nothing here recognises, must still end with
 * somewhere to go rather than with a dead end. `flows replay` is that command —
 * it already exists and already prints the full journal; nothing ever named it
 * at the moment of failure, which is why the surface looked like it had no way
 * to inspect a finished run.
 */
export function inspectionHint(
  runId: string,
  stepId: string | undefined,
  dataDir: string | undefined,
): { hint: string; journalPath?: string } {
  const at = stepId === undefined ? '' : ` --at ${shellQuote(stepId)}`;
  // Only name a non-default data dir: repeating the default back at an
  // operator who never typed it is noise, and `flows replay` defaults to the
  // same value (cli.ts).
  const dir = dataDir === undefined || dataDir === DEFAULT_DATA_DIR
    ? '' : ` --data-dir ${shellQuote(dataDir)}`;
  return {
    hint: `flows replay ${shellQuote(runId)}${at}${dir}`,
    // Left as the operator spelled it rather than resolved: `.relayflowd/...`
    // is what they will recognise in their own working directory.
    ...(dataDir === undefined ? {} : { journalPath: join(dataDir, 'runs', `${runId}.sqlite3`) }),
  };
}

/**
 * Pull the process-shaped fields out of whichever field carried them.
 *
 * `verification.detail` is last because it is the daemon's own render rather
 * than the worker's structured report — but for an agent step it is the only
 * thing that survives, so it is parsed when it parses and kept verbatim when
 * it does not. A truncated render (the daemon caps at 2,000 chars and appends
 * a truncation note) will not parse; that falls through to the raw string,
 * which is still the account of what went wrong.
 *
 * An agent or llm completion now also carries `trajectory_tail.transcript`
 * (agent-transcript.ts) on every attempt. That object is not process-shaped,
 * so it must not shadow the render that is: the first candidate that carries
 * an exit code or a tail wins. The digest contributes what only it has — the
 * failure excerpt the worker picked out of the provider's frames, and the
 * path of the transcript file.
 */
function evidence(payload: Record<string, unknown>): Partial<StepFailedDetails> {
  const detail = record(payload['verification'])?.['detail'];
  const candidates = [
    record(payload['output']),
    record(payload['trajectory_tail']),
    typeof detail === 'string' ? parsed(detail) : undefined,
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  const structured = candidates.find(processShaped) ?? candidates[0];
  const transport = record(record(payload['trajectory_tail'])?.['transport']);
  const exitCode = structured?.['exit_code'] ?? transport?.['exit_code'];
  const stdout = structured?.['stdout_tail'];
  const stderr = structured?.['stderr_tail'] ?? transport?.['stderr_tail'];
  const structuredShape = structured !== undefined && processShaped(structured);
  const transcript = record(record(payload['trajectory_tail'])?.['transcript']);
  const failure = record(transcript?.['failure']);
  const excerpt = failure?.['excerpt'];
  const transcriptPath = record(transcript?.['file'])?.['path'];
  // The excerpt is the worker's own pick of the failure; a `stderr` excerpt
  // is the same bytes as `stderrTail`, so it is not printed twice.
  const excerptDetail = typeof excerpt === 'string' && excerpt.length > 0
    && !(failure?.['kind'] === 'stderr' && typeof stderr === 'string')
    ? tail(excerpt) : undefined;
  return {
    ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(typeof transport?.['phase'] === 'string' ? { transportPhase: tail(transport['phase']) } : {}),
    ...(typeof transport?.['cause'] === 'string' ? { transportCause: tail(transport['cause']) } : {}),
    ...(typeof transport?.['signal'] === 'string' ? { signal: tail(transport['signal']) } : {}),
    ...(typeof transport?.['error_code'] === 'string' ? { errorCode: tail(transport['error_code']) } : {}),
    ...(typeof transport?.['retryable'] === 'boolean' ? { retryableTransport: transport['retryable'] } : {}),
    ...(typeof stdout === 'string' && stdout.length > 0 ? { stdoutTail: tail(stdout) } : {}),
    ...(typeof stderr === 'string' ? { stderrTail: tail(stderr) } : {}),
    // Keep the daemon's account only when it was NOT just a render of the
    // fields above — otherwise the same bytes print twice.
    ...(excerptDetail !== undefined ? { detail: excerptDetail }
      : typeof detail === 'string' && detail.length > 0 && !structuredShape
        ? { detail: tail(detail) } : {}),
    ...(typeof transcriptPath === 'string' && transcriptPath.length > 0 ? { transcriptPath } : {}),
  };
}

function processShaped(value: Record<string, unknown>): boolean {
  return typeof value['exit_code'] === 'number'
    || typeof value['stdout_tail'] === 'string' || typeof value['stderr_tail'] === 'string';
}

function parsed(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function tail(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - TAIL_BYTES);
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
