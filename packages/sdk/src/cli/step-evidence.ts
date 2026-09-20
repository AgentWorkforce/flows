import { redact } from '../redact.js';
import type {
  AttemptEvidenceComparison,
  StepAttemptFailure,
  StepFailedDetails,
} from '../failure-kinds.js';

/** The terminal attempt's bound, unchanged: it is the primary account. */
export const TAIL_BYTES = 1_024;

/** Per-attempt history is context beside that account, not a second copy of it. */
export const ATTEMPT_TAIL_BYTES = 256;

/**
 * What the daemon appends when it cut a render before journaling it
 * (`worker_failure_detail`, relayflowd/src/engine/remote.rs). Evidence that
 * arrived already truncated cannot establish that two attempts failed
 * identically, however equal the surviving bytes are.
 */
const PRODUCER_TRUNCATED = /…\s*\((?:render bounded|[\d,]+ bytes truncated)\)$/u;

/**
 * The evidence fields a step failure reports, as the journal held them.
 *
 * Extraction and display bounds are separated deliberately. The terminal
 * attempt renders at 1,024 bytes and each historical attempt at 256, but the
 * COMPARISON that decides whether a retry failed differently runs on the
 * unbounded record (`failureCause`): two different errors can share a 256-byte
 * suffix, and calling those the same failure is the bug this reader exists to
 * avoid.
 */
export interface SelectedEvidence {
  exitCode?: number;
  /** Present only when nonempty. */
  stdoutTail?: string;
  /** Present whenever the journal carried one, including the empty string. */
  stderrTail?: string;
  detail?: string;
  transcriptPath?: string;
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
export function selectEvidence(payload: Record<string, unknown>): SelectedEvidence {
  const detail = record(payload['verification'])?.['detail'];
  const rendered = typeof detail === 'string' ? parsed(detail) : undefined;
  const candidates = [
    record(payload['output']),
    record(payload['trajectory_tail']),
    rendered,
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  const structured = candidates.find(processShaped) ?? candidates[0];
  const exitCode = structured?.['exit_code'];
  const stdout = structured?.['stdout_tail'];
  const stderr = structured?.['stderr_tail'];
  const transcript = record(record(payload['trajectory_tail'])?.['transcript']);
  const failure = record(transcript?.['failure']);
  const excerpt = failure?.['excerpt'];
  const transcriptPath = record(transcript?.['file'])?.['path'];
  // The excerpt is the worker's own pick of the failure; a `stderr` excerpt
  // is the same bytes as `stderrTail`, so it is not printed twice.
  const excerptDetail = typeof excerpt === 'string' && excerpt.length > 0
    && !(failure?.['kind'] === 'stderr' && typeof stderr === 'string')
    ? excerpt : undefined;
  return {
    ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(typeof stdout === 'string' && stdout.length > 0 ? { stdoutTail: stdout } : {}),
    ...(typeof stderr === 'string' ? { stderrTail: stderr } : {}),
    ...(excerptDetail !== undefined ? { detail: excerptDetail }
      : typeof detail === 'string' && detail.length > 0 && !duplicates(detail, rendered, exitCode)
        ? { detail } : {}),
    ...(typeof transcriptPath === 'string' && transcriptPath.length > 0 ? { transcriptPath } : {}),
  };
}

/**
 * Whether printing `verification.detail` would print bytes already printed.
 *
 * Only two shapes do. The daemon's render of a worker failure IS the
 * `{exit_code, stdout_tail, stderr_tail}` report (`worker_failure_detail`,
 * relayflowd/src/engine/remote.rs), which a deterministic step journals
 * alongside its preserved `output`; and the `exit_code` gate's verdict on its
 * own is the exit code that is already reported beside it (`exit code was 1`,
 * relayflowd-core/src/verify.rs).
 *
 * Every other verdict is the ONLY account of its failure. `output did not
 * contain "READY"` accompanies exit 0 and empty tails, so suppressing the
 * detail whenever some field happened to be process-shaped left the attempt
 * saying `exit=0 — no failure evidence recorded` while the journal held the
 * gate error — the first attempt hidden again, inside the diagnostic that
 * exists to surface it.
 */
function duplicates(
  detail: string,
  rendered: Record<string, unknown> | undefined,
  exitCode: unknown,
): boolean {
  if (rendered !== undefined && processShaped(rendered)) return true;
  return typeof exitCode === 'number' && detail === `exit code was ${exitCode}`;
}

/** The `StepFailedDetails` scalars for one completion, at the terminal bound. */
export function terminalEvidence(payload: Record<string, unknown>): Partial<StepFailedDetails> {
  const selected = selectEvidence(payload);
  return {
    ...(selected.exitCode === undefined ? {} : { exitCode: selected.exitCode }),
    ...(selected.stdoutTail === undefined ? {} : { stdoutTail: tail(selected.stdoutTail) }),
    ...(selected.stderrTail === undefined ? {} : { stderrTail: tail(selected.stderrTail) }),
    ...(selected.detail === undefined ? {} : { detail: tail(selected.detail) }),
    ...(selected.transcriptPath === undefined ? {} : { transcriptPath: selected.transcriptPath }),
  };
}

/**
 * One historical attempt's record, redacted and then bounded.
 *
 * Redaction runs first so a credential cannot survive by sitting outside the
 * excerpt window on one attempt and inside it on another. Control-character
 * replacement alone is not redaction: an agent that echoed `rk_live_...` into
 * its stderr would otherwise reach a terminal through this new field.
 */
export function attemptFailure(
  attempt: unknown,
  completionReason: string,
  disposition: unknown,
  payload: Record<string, unknown>,
): StepAttemptFailure {
  const selected = selectEvidence(payload);
  let truncated = false;
  const bound = (value: string): string => {
    const redacted = redact(value);
    if (Buffer.byteLength(redacted, 'utf8') > ATTEMPT_TAIL_BYTES) truncated = true;
    return tail(redacted, ATTEMPT_TAIL_BYTES);
  };
  const record_: StepAttemptFailure = {
    ...(typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt > 0
      ? { attempt } : {}),
    completionReason,
    ...(typeof disposition === 'string' && disposition.length > 0 ? { disposition } : {}),
    ...(selected.exitCode === undefined ? {} : { exitCode: selected.exitCode }),
    ...(selected.stdoutTail === undefined ? {} : { stdoutTail: bound(selected.stdoutTail) }),
    ...(selected.stderrTail === undefined ? {} : { stderrTail: bound(selected.stderrTail) }),
    ...(selected.detail === undefined ? {} : { detail: bound(selected.detail) }),
  };
  return truncated ? { ...record_, truncated } : record_;
}

/**
 * Everything about a completion that bears on WHY it failed, unbounded.
 *
 * Deliberately not the display selection: `selectEvidence` suppresses the
 * daemon's render when process-shaped output exists, and prefers a transcript
 * excerpt over both, so two attempts can show identical excerpts over
 * different gate verdicts. Everything the journal recorded about the failure
 * is read here instead, before any bound is applied.
 *
 * Timestamps, transcript paths, dispositions and attempt numbers are NOT
 * causes and are excluded: they differ on every attempt by construction.
 */
export function failureCause(
  completionReason: string,
  payload: Record<string, unknown>,
): AttemptCause {
  const verification = record(payload['verification']);
  const output = record(payload['output']);
  const trajectory = record(payload['trajectory_tail']);
  const failure = record(record(trajectory?.['transcript'])?.['failure']);
  const verificationDetail = text(verification?.['detail']);
  const accounts = [
    verificationDetail,
    text(output?.['stdout_tail']), text(output?.['stderr_tail']),
    text(trajectory?.['stdout_tail']), text(trajectory?.['stderr_tail']),
    text(failure?.['excerpt']),
  ];
  const exitCodes = [output?.['exit_code'], trajectory?.['exit_code']]
    .filter(value => typeof value === 'number');
  return {
    key: JSON.stringify([
      // `verification_failed` on a retry and `retries_exhausted` at the budget
      // limit are the SAME fallback over the same failure: `completion_actions`
      // picks the label from the branch it took, not from the cause. Comparing
      // them literally would report "the retry failed differently" on every
      // ordinary repeated failure. No other pair of labels is collapsed.
      completionReason === 'verification_failed' || completionReason === 'retries_exhausted'
        ? 'kernel_rejected' : completionReason,
      text(verification?.['gate']), text(verification?.['verdict']), verificationDetail,
      ...exitCodes, ...accounts, text(failure?.['kind']),
    ]),
    // An attempt that journaled nothing about itself cannot agree with
    // another one; it can only fail to disagree.
    recorded: exitCodes.length > 0 || accounts.some(account => account !== undefined),
    producerTruncated: verificationDetail !== undefined
      && PRODUCER_TRUNCATED.test(verificationDetail),
  };
}

export interface AttemptCause {
  readonly key: string;
  readonly recorded: boolean;
  readonly producerTruncated: boolean;
}

/**
 * Only attempts that recorded something can establish a difference.
 *
 * An attempt that journaled no account of itself differs from every other one
 * on paper while saying nothing about why it failed, and reporting that as
 * `differs` would put "an earlier attempt may have had side effects" on a
 * crash that is evidence of nothing. Truncation is not the same case: two
 * renders the daemon already cut can only look MORE alike than they were, so
 * surviving bytes that disagree still prove the causes disagreed.
 */
export function compareAttempts(causes: readonly AttemptCause[]): AttemptEvidenceComparison {
  const recorded = causes.filter(cause => cause.recorded);
  if (new Set(recorded.map(cause => cause.key)).size > 1) return 'differs';
  return recorded.length === causes.length && causes.every(cause => !cause.producerTruncated)
    ? 'unchanged' : 'unknown';
}

const COMPARISON_CLAUSE: Record<AttemptEvidenceComparison, string> = {
  differs: 'recorded failure evidence differs. An earlier attempt may have had side effects.',
  unchanged: 'recorded failure evidence is unchanged across them.',
  unknown: 'recorded failure evidence is incomplete, so whether the causes differ is unknown.',
};

/**
 * Every failed attempt, oldest first, under one line saying whether they
 * agree. Rendered in full rather than elided: `flows logs` prints the runner
 * log without eliding it, so an attempt dropped here is an attempt that
 * reaches no reader at all.
 */
export function renderAttemptHistory(details: StepFailedDetails): string {
  const attempts = details.attempts;
  if (attempts === undefined || attempts.length < 2) return '';
  const comparison = COMPARISON_CLAUSE[details.attemptEvidence ?? 'unknown'];
  return [`\nAttempts: ${attempts.length} failed; ${comparison}`, ...attempts.map(renderAttempt)]
    .join('\n');
}

function renderAttempt(attempt: StepAttemptFailure): string {
  const head = `  attempt ${attempt.attempt ?? '?'}: ${attempt.completionReason ?? 'unknown'}`
    + (attempt.exitCode === undefined ? '' : ` exit=${attempt.exitCode}`)
    + (attempt.truncated ? ' (excerpt truncated)' : '');
  // An empty `stderrTail` is a journaled fact but not an account of anything,
  // so it never displaces useful stdout the way `detail ?? stderr ?? stdout`
  // would. Both are kept when both exist.
  const accounts: Array<[string, string]> = [
    ['detail', attempt.detail], ['stderr', attempt.stderrTail], ['stdout', attempt.stdoutTail],
  ].filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].length > 0);
  if (accounts.length === 0) return `${head} — no failure evidence recorded`;
  const [only] = accounts;
  if (accounts.length === 1 && !only![1].includes('\n')) return `${head} — ${only![0]}: ${only![1]}`;
  return [head, ...accounts.map(([label, value]) => indent(`${label}: ${value}`))].join('\n');
}

/** Continuation lines are indented past the label so the list stays readable. */
function indent(block: string): string {
  const [first, ...rest] = block.split('\n');
  return [`    ${first}`, ...rest.map(line => `      ${line}`)].join('\n');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function tail(value: string, limit = TAIL_BYTES): string {
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - limit);
  // Drop a partial leading code point, avoiding replacement-byte expansion.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  // Preserve tabs/newlines; replace binary controls (including ESC and CR),
  // C1 controls and Unicode formatting controls without growing the excerpt.
  return bytes.subarray(start).toString('utf8')
    .replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' || character === '\t' ? character : '?');
}
