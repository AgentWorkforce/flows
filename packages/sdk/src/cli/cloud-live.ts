// `flows status --cloud --watch` and `flows logs <run> --follow`: the two
// hosted reads that keep reading.
//
// The one-shot verbs (cli/cloud-read.ts) answer "what did that run do". These
// two answer "what is it doing", by asking again until the run is over. Three
// properties separate them from a loop around the one-shot reads:
//
//  1. **The exit code is the run's.** A finished page is not evidence that the
//     run succeeded; `getCloudRunDetailLive` validates the same record
//     `flows run --wait` blocks on, so `--watch` and `--follow` exit 0 only on
//     an attested `completed`/`success`, 1 on an attested failure or a
//     cancellation, and refuse a terminal record that attests neither.
//  2. **A frame is whole or absent.** The page is rendered, then the abort is
//     checked, then the whole page leaves in one `io.stdout` call. A Ctrl-C
//     mid-poll ends the command with a refusal and no half-drawn screen.
//  3. **Nothing is invented while waiting.** A failed poll leaves the previous
//     page and the consumed log exactly where they were; it never clears the
//     screen to show an error, and never re-prints a line it has shown.
//
// Cancellation is the caller's: `runCli` hands these functions the signal it
// owns for the verb's duration, and nothing here installs a process handler.
// Aborting stops the observation, not the hosted run — the refusal says so.

import { canonicalize } from '../canonical.js';
import {
  getCloudRunDetailLive, getCloudRunLog, getCloudRunSteps,
  type CloudRunDetail, type CloudRunLog, type CloudStep,
} from '../cloud-read.js';
import { isCloudRunActive, type CloudRunState } from '../cloud-run-record.js';
import { endsWithOpenCredentialHeader, openCredentialStart, openSecretStart, redact } from '../redact.js';
import { thousands } from './cloud-format.js';
import { fail, isTransientRead, refusalFor, RUN_ID_REQUIRED, type CloudReadOptions } from './cloud-refusal.js';
import { renderCloudStatus, scrubRun, scrubSteps } from './cloud-status-view.js';
import { sleepInterruptible } from './interruptible-sleep.js';
import type { CliIo } from '../cli.js';

/** The cadence `waitForCloudFlowRun` polls at; not a user flag on either verb. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

export interface CloudLiveOptions extends CloudReadOptions {
  /** Milliseconds between polls. Injected by tests; 1..60000, as the waiter accepts. */
  pollIntervalMs?: number;
  /** Injected by tests so no suite sleeps; production uses the abortable sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Clears the screen only for a terminal; a redirected page must stay text. */
function clearSequence(io: CliIo): string {
  return io.tty === true ? '\u001b[2J\u001b[H' : '';
}

/** The same delay schedule as `waitForCloudFlowRun`: ×2 per failure, capped. */
function delayFor(failures: number, interval: number): number {
  return failures === 0 ? interval : Math.min(interval * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

/** The hosted `flows run --wait` mapping: only an attested success is 0. */
function exitFor(state: CloudRunState): 0 | 1 {
  return state.status === 'completed' ? 0 : 1;
}

function aborted(verb: 'watching' | 'following', runId: string, json: boolean, io: CliIo): 1 {
  fail({
    code: 'observation_aborted', exit: 1,
    message: `Stopped ${verb} run ${runId}; the hosted run has not been cancelled.`,
  }, json, io);
  return 1;
}

/**
 * Has the caller cancelled?
 *
 * A function rather than `signal?.aborted` at each site on purpose: `aborted`
 * is a readonly property, so an inline check narrows the signal's type for the
 * rest of the block and the compiler then calls every later check dead — which
 * is exactly backwards for a value that changes under an await.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function invalidInterval(interval: number): boolean {
  return !Number.isSafeInteger(interval) || interval < 1 || interval > 60_000;
}

// -------------------------------------------------- flows status --cloud --watch

/**
 * Redraw the hosted status page until the run is terminal, then leave the
 * final page up and exit with the run's outcome.
 *
 * The detail and the step rows are two requests against two projections, so
 * the page is a pair of reads and not an atomic snapshot: a step row can lag
 * the header it is drawn under by one poll. That is a property of the API, and
 * this view reports what each read said rather than reconciling them.
 */
export async function runCloudStatusWatch(
  args: { runId?: string; json: boolean },
  io: CliIo,
  options: CloudLiveOptions = {},
): Promise<0 | 1 | 2> {
  const env = options.env ?? process.env;
  const clock = options.now ?? Date.now;
  const signal = options.signal;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? sleepInterruptible;
  if (args.runId === undefined || args.runId.length === 0) return fail(RUN_ID_REQUIRED, args.json, io);
  const runId = args.runId;
  if (invalidInterval(interval)) {
    return fail({ code: 'cloud_configuration', exit: 2, message: 'pollIntervalMs must be an integer from 1 to 60000.' },
      args.json, io);
  }

  let failures = 0;
  for (;;) {
    if (isAborted(signal)) return aborted('watching', runId, args.json, io);
    let live: { detail: CloudRunDetail; state: CloudRunState };
    let steps: CloudStep[];
    try {
      live = await getCloudRunDetailLive(runId, options);
      if (isAborted(signal)) return aborted('watching', runId, args.json, io);
      steps = await getCloudRunSteps(runId, options);
    } catch (error) {
      if (isAborted(signal)) return aborted('watching', runId, args.json, io);
      if (!isTransientRead(error)) return fail(refusalFor(error, `run ${runId}`, env), args.json, io);
      // The previous page stays exactly as it was: a poll that did not
      // complete is not news about the run.
      failures = Math.min(failures + 1, 16);
      await sleep(delayFor(failures, interval), signal);
      continue;
    }
    failures = 0;

    const run = scrubRun(live.detail, env);
    const scrubbed = scrubSteps(steps, env);
    const terminal = !isCloudRunActive(live.state.status);
    // Rendered before the abort check and emitted after it, in one call: an
    // interrupt between two lines of a frame would leave a torn page.
    const page = args.json ? '' : `${clearSequence(io)}${renderCloudStatus(run, scrubbed, clock()).join('\n')}`;
    if (isAborted(signal)) return aborted('watching', runId, args.json, io);
    if (!args.json) io.stdout(page);
    if (terminal) {
      if (args.json) io.stdout(canonicalize({ v: 1, ok: true, run, steps: scrubbed, now_ms: clock() }));
      return exitFor(live.state);
    }
    await sleep(interval, signal);
  }
}

// ------------------------------------------------------ flows logs --follow

/**
 * What has been shown of the runner log, and where the rest starts.
 *
 * Bookkeeping is kept on the log exactly as Cloud served it, before redaction:
 * the un-released remainder is redacted as one block on every poll, so a
 * secret is matched against the whole text it spans — several lines of a PEM,
 * or halves that arrived in two different polls — rather than against one line
 * at a time, which no multi-line value can ever match.
 */
interface LogFollowState {
  /** The whole log as last served, held to prove the next read extends it. */
  consumed: string;
  /** How much of `consumed` has been printed; the rest is still redactable. */
  released: number;
  emitted: boolean;
}

/**
 * Print `text` as lines.
 *
 * Splitting is on `\n` only, and one trailing `\r` per line is dropped: a
 * CRLF log printed with its carriage returns intact makes a terminal overwrite
 * each line it just drew. A final newline ends the last line rather than
 * starting an empty one. Blank lines and repeated identical lines are
 * preserved — they are the log.
 */
function writeLines(text: string, state: LogFollowState, io: CliIo): void {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    io.stdout(line.replace(/\r$/u, ''));
    state.emitted = true;
  }
}

/** The last line boundary at or before `at`: 0, or the index after a newline. */
function lineBoundaryAtOrBefore(text: string, at: number): number {
  return at <= 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1;
}

/**
 * Release every line the log has settled on, redacted as one block.
 *
 * Four things hold a line back. `openSecretStart` marks where a secret value
 * has begun and not ended, so nothing at or past it can be shown until the
 * next poll completes it. `openCredentialStart` marks a trailing credential
 * header — `authorization:`, `Bearer`, a callback-token name, or an
 * unterminated credential JSON field — whose value may only arrive on a later
 * poll; releasing the header first would leave the value without the context
 * the redactor needs. A block is never ended on a bare credential header even
 * when more text follows, because the redactor folds the header's newline
 * into its own match — the block-prefix check cannot see that the header's
 * value lives on the next line. And a candidate block is released only when
 * redacting it alone gives the same text as the front of the whole redacted
 * remainder: if the cut fell inside something the redactor would have caught —
 * the second line of a private key — the two disagree, and the cut moves back
 * a line and is tried again.
 *
 * A poll that can release nothing prints nothing; the bytes are not lost, they
 * are held until a later poll or the drain flush can redact them whole.
 */
function releaseLines(state: LogFollowState, io: CliIo, env: NodeJS.ProcessEnv): void {
  const raw = state.consumed;
  if (state.released >= raw.length) return;
  const remainder = redact(raw.slice(state.released), env);
  let cut = lineBoundaryAtOrBefore(raw, Math.min(openSecretStart(raw, env), openCredentialStart(raw)));
  while (cut > state.released) {
    if (endsWithOpenCredentialHeader(raw.slice(state.released, cut))) {
      // A bare credential header as the released block's last line strands
      // the value that starts on the next line — redact needs them together.
      // Shrink until the header is inside the held remainder; it releases
      // with its value line once that line is complete.
      cut = lineBoundaryAtOrBefore(raw, cut - 1);
      continue;
    }
    const block = redact(raw.slice(state.released, cut), env);
    if (remainder.startsWith(block)) {
      writeLines(block, state, io);
      state.released = cut;
      return;
    }
    cut = lineBoundaryAtOrBefore(raw, cut - 1);
  }
}

/**
 * Has Cloud finished publishing this log?
 *
 * Three facts, all required. The run being over does not mean the last bytes
 * have been written; `done` alone does not mean the run is over (the route can
 * report a completed *upload* of a log the run is still adding to); and a
 * `done` envelope that carries fewer bytes than it advertises has not served
 * the tail. Stopping on any one of them alone would truncate the output, which
 * is the one thing a follow must not do.
 */
function logDrained(log: CloudRunLog, terminal: boolean, content: string): boolean {
  return terminal && log.done && Buffer.byteLength(content, 'utf8') >= log.total_size;
}

/**
 * Append the hosted runner log until the run is terminal and its log is drained.
 *
 * The route serves the log from an offset, but this client does not page it:
 * the offsets are byte counts and the content is a JavaScript string, and
 * subtracting one from the other silently loses text the moment a log contains
 * a non-ASCII character — which the runner's own transition lines do. Until
 * the byte-range contract can be checked against the server, each poll reads
 * the whole log and prints the part that is new, refusing outright if what it
 * already showed is no longer a prefix of what Cloud serves. That costs a full
 * read per poll and holds the log in memory; it cannot duplicate or drop a line.
 */
export async function runCloudLogsFollow(
  args: { runId: string; step: string | undefined; json: boolean },
  io: CliIo,
  options: CloudLiveOptions = {},
): Promise<0 | 1 | 2> {
  const env = options.env ?? process.env;
  const signal = options.signal;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? sleepInterruptible;
  const runId = args.runId;
  // Refused before any request: a step transcript is not an append-only stream
  // this verb can follow. A retry replaces it, and the rendered form is built
  // from the whole JSONL — attempt markers, session header, result footer —
  // rather than a line at a time.
  if (args.step !== undefined) {
    return fail({
      code: 'invalid_invocation', exit: 2,
      message: '`flows logs --follow` follows the runner log, which is append-only; it cannot follow a step '
        + 'transcript. Follow the run with `flows logs <run-id> --follow`, or read the step transcript once '
        + 'with `flows logs <run-id> --step <name>`.',
    }, args.json, io);
  }
  if (invalidInterval(interval)) {
    return fail({ code: 'cloud_configuration', exit: 2, message: 'pollIntervalMs must be an integer from 1 to 60000.' },
      args.json, io);
  }

  const state: LogFollowState = { consumed: '', released: 0, emitted: false };
  let header = false;
  let failures = 0;
  // A snapshot that satisfies every drain fact can still predate terminality:
  // `done` can describe an upload finished while the run kept writing, and the
  // log route can keep serving that snapshot past the terminal transition.
  // The read that ends the follow has to postdate the terminal observation —
  // which on the first sighting it cannot — so a terminal run always gets one
  // more poll before its log counts as drained.
  let terminalObserved = false;
  for (;;) {
    if (isAborted(signal)) return aborted('following', runId, args.json, io);
    let outcome: CloudRunState;
    let log: CloudRunLog;
    try {
      // The run record first: a log read that follows a terminal status can
      // only be missing bytes Cloud had not published yet, never bytes written
      // after the check.
      const live = await getCloudRunDetailLive(runId, options);
      if (isAborted(signal)) return aborted('following', runId, args.json, io);
      log = await getCloudRunLog(runId, undefined, options);
      outcome = live.state;
    } catch (error) {
      if (isAborted(signal)) return aborted('following', runId, args.json, io);
      if (!isTransientRead(error)) return fail(refusalFor(error, `run ${runId}`, env), args.json, io);
      failures = Math.min(failures + 1, 16);
      await sleep(delayFor(failures, interval), signal);
      continue;
    }
    failures = 0;
    if (isAborted(signal)) return aborted('following', runId, args.json, io);

    if (!log.content.startsWith(state.consumed)) {
      return fail({
        code: 'cloud_log_rewritten', exit: 1,
        message: `Cloud's runner log for run ${runId} no longer begins with the ${thousands(state.consumed.length)} `
          + 'characters already shown, so following it would skip or repeat output. Read it whole with '
          + `\`flows logs ${runId}\`.`,
      }, args.json, io);
    }
    state.consumed = log.content;
    const terminal = !isCloudRunActive(outcome.status);
    const drained = terminalObserved && logDrained(log, terminal, log.content);
    terminalObserved ||= terminal;

    if (!args.json) {
      if (!header) {
        io.stdout(`LOG ${runId}  runner  following  ${thousands(log.total_size)} bytes so far`);
        header = true;
      }
      releaseLines(state, io, env);
    }
    if (!drained) {
      await sleep(interval, signal);
      continue;
    }
    // Drained: the last line may have no newline, and this is the only moment
    // at which printing it cannot cut a line in half.
    if (args.json) {
      io.stdout(canonicalize({
        v: 1, ok: true, run_id: runId, step: null,
        bytes: log.offset, total_bytes: log.total_size, done: log.done,
        content: redact(log.content, env),
      }));
      return exitFor(outcome);
    }
    if (state.released < state.consumed.length) {
      writeLines(redact(state.consumed.slice(state.released), env), state, io);
      state.released = state.consumed.length;
    }
    if (!state.emitted) io.stdout('  (empty)');
    io.stdout(`${outcome.status.toUpperCase()} ${runId} completionReason: `
      + `${'completionReason' in outcome ? outcome.completionReason : 'unavailable'}`);
    return exitFor(outcome);
  }
}
