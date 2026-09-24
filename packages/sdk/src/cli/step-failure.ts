import { join } from 'node:path';
import { DEFAULT_DATA_DIR } from '../daemon-connection.js';
import type { StepAttemptFailure, StepFailedDetails } from '../failure-kinds.js';
import type { JournalClient } from '../journal-client.js';
import {
  attemptFailure,
  compareAttempts,
  failureCause,
  record,
  renderAttemptHistory,
  terminalEvidence,
  type AttemptCause,
} from './step-evidence.js';

/** Every failed attempt of one step, in journal order, with its causes. */
interface AttemptHistory {
  records: StepAttemptFailure[];
  causes: AttemptCause[];
}

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
 * relayflowd/src/engine/remote.rs). Both are read by `selectEvidence`, in that
 * order, and the daemon's render is re-parsed when it carries that same shape.
 *
 * EVERY failed attempt is collected, not only the terminal one. The kernel
 * appends a `step.completed` per attempt, so a retried step's first failure is
 * in the journal — but `retries_exhausted` reported only the last attempt, and
 * a retry that fails differently (because the first attempt already had a side
 * effect) is exactly when the last attempt is the least informative record
 * there is. The scalar fields still describe the terminal attempt; `attempts`
 * is additive.
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
  // Keyed by step, so interleaved steps never pool their attempts and a page
  // boundary never splits one step's history.
  const histories = new Map<string, AttemptHistory>();
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
        continue;
      }
      if (entry['entry_type'] !== 'step.completed') continue;
      // A later completion supersedes an earlier failed attempt.
      failures.delete(stepId);
      const payload = record(entry['payload']);
      const completionReason = payload?.['completionReason'];
      // A success — or a completion this reader cannot read — ends the failure
      // history too: what a step that eventually succeeded printed on the way
      // is not the diagnosis of a later, different failure. The journal still
      // holds every entry; only this diagnostic's candidate is cleared.
      if (payload === undefined || typeof completionReason !== 'string' || completionReason === 'success') {
        histories.delete(stepId);
        continue;
      }
      const history = histories.get(stepId) ?? { records: [], causes: [] };
      // Recorded for `retry` and `park` alike: the kernel's disposition says
      // what it did next, not whether the attempt failed.
      history.records.push(attemptFailure(entry['attempt'], completionReason, payload['disposition'], payload));
      history.causes.push(failureCause(completionReason, payload));
      histories.set(stepId, history);
      // A terminal completion that is not a success is the failure, whatever
      // its step type. The old predicate also demanded a non-zero `exit_code`,
      // which no agent completion carries and which a deterministic step that
      // exits 0 and then fails its gate does not carry either — both were
      // silently skipped.
      if (payload['disposition'] !== 'step_done') continue;
      const stepType = snapshot.steps[stepId]?.type;
      const attempt = entry['attempt'];
      const maxIterations = budgets.get(stepId);
      failures.set(stepId, {
        stepId,
        completionReason,
        ...(stepType === undefined ? {} : { stepType }),
        ...(typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt > 0 ? { attempt } : {}),
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...terminalEvidence(payload),
        // A single failed attempt is already fully described by the scalars
        // above; repeating it as a one-element history would add a clause to
        // every ordinary failure report without adding a fact.
        ...(history.records.length > 1
          ? { attempts: history.records, attemptEvidence: compareAttempts(history.causes) }
          : {}),
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
 * The attempt history follows that line and precedes the terminal attempt's
 * own clauses, so the first error is visible without scrolling past the last
 * one's output tails.
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
    + (details.exitCode === undefined ? '' : ` exit=${details.exitCode}`)
    + '.'
    + renderAttemptHistory(details)
    + (details.detail === undefined ? '' : `\nDetail: ${details.detail}`)
    + (details.stdoutTail ? `\nStdout (captured excerpt):\n${details.stdoutTail}` : '')
    + (details.stderrTail ? `\nStderr (captured excerpt):\n${details.stderrTail}` : '')
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

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) && !value.startsWith('-')
    ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
