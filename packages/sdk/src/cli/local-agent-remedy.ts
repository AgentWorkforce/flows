import { resumeCommand } from '../authored-human.js';
import type { ParkCause } from '../failure-kinds.js';
import { shellQuote, shellWord } from '../shell-word.js';

/**
 * What to tell someone whose run stopped for want of an agent worker.
 *
 * A closed union rather than a bag of optional fields: the remedy for a spec
 * run is a *new* run, for a spec resume it is *this* run, and for an authored
 * `.flow.ts` it is a new run that must carry the same `--input` — three
 * different sentences, and no combination of them is meaningful. `attached`
 * is the case the message used to get wrong by omission: a worker WAS offered
 * and none of them was eligible, so naming the flag again is not the fix.
 */
export type LocalAgentRemedy =
  /** Nothing to say: not a worker park, or the caller renders it elsewhere. */
  | { kind: 'none' }
  | { kind: 'attached' }
  | { kind: 'spec-run'; path: string; dataDir?: string }
  | { kind: 'spec-resume'; runId: string; dataDir?: string }
  | { kind: 'authored-run'; path: string; input: AuthoredInput; dataDir?: string };

/**
 * The `--input` argument a new run of an authored flow would have to repeat.
 *
 * Three outcomes, not an optional string, because each is a different sentence
 * and only one of them ends in a command. None of them is `{}`: fabricating an
 * input would hand over a command that runs a different flow invocation than
 * the one that parked.
 */
export type AuthoredInput =
  /** The argument this run was started with, rendered back verbatim. */
  | { kind: 'inline'; argument: string }
  /** The journal recorded no input argument to repeat. */
  | { kind: 'absent' }
  /** Recorded, but too many bytes to hand a shell as one word. */
  | { kind: 'oversized'; bytes: number };

/**
 * The largest `--input` value worth printing inline, in bytes.
 *
 * Linux caps a single `execve` argument at `MAX_ARG_STRLEN` — 32 pages,
 * 131072 bytes including the terminating NUL — independently of the much
 * larger `ARG_MAX` total. `MAX_DIRECT_INPUT_BYTES` admits a full mebibyte, so
 * a run started from a perfectly ordinary input file can have recorded more
 * input than any shell can pass back. Printing it anyway yields a command that
 * dies with `Argument list too long` before the CLI is even reached, which is
 * no better than the park it was meant to answer.
 */
const MAX_INLINE_INPUT_BYTES = 131_071;

/** How a recorded input argument should be rendered, given its size. */
export function authoredInput(argument: string | undefined): AuthoredInput {
  if (argument === undefined) return { kind: 'absent' };
  const bytes = Buffer.byteLength(argument, 'utf8');
  return bytes > MAX_INLINE_INPUT_BYTES ? { kind: 'oversized', bytes } : { kind: 'inline', argument };
}

/**
 * The declared-surface caveat, stated as the condition it is.
 *
 * A step that declares a workspace or a stream needs a worker holding those
 * pins, and the local agent worker holds only its own stream. That is worth
 * saying next to the command — but it is a caveat on the remedy, not a
 * diagnosis of this park, and it is phrased so it cannot be read as one.
 */
const PINS = 'Declared workspace or stream surfaces require a worker that holds their pins.';

/**
 * The remedy clause appended to a worker-park diagnostic, with a leading
 * space, or `''` when there is nothing to add.
 */
export function localAgentRemedy(remedy: LocalAgentRemedy): string {
  switch (remedy.kind) {
    case 'none':
      return '';
    case 'attached':
      // Never "pass --local-agent": it was passed. The honest report is that
      // a worker was offered and the daemon matched none of them to this step.
      return ' A local agent worker is already attached to this run, so passing --local-agent again'
        + ' changes nothing: no attached worker was eligible for this step.'
        + ` ${PINS} The local agent worker holds only its own stream.`;
    case 'spec-run':
      return ` To start a new run with a local agent worker: ${
        newRunCommand(remedy.path, undefined, remedy.dataDir)}. ${PINS}`;
    case 'spec-resume':
      // This run is resumable, so the remedy is this run — not a new one.
      return ` To continue this run with a local agent worker: ${
        resumeCommand(remedy.runId, remedy.dataDir, true)}. ${PINS}`;
    case 'authored-run':
      return authoredRunRemedy(remedy);
  }
}

/**
 * Either a runnable new run, or the requirement stated in prose.
 *
 * Prose, not a command, whenever the `--input` cannot be printed as something
 * a shell would deliver intact: a `.flow.ts` invocation without its `--input`
 * is refused (`input_missing`), and a placeholder or a truncation in its place
 * is worse than a sentence, because it looks runnable.
 */
function authoredRunRemedy(remedy: Extract<LocalAgentRemedy, { kind: 'authored-run' }>): string {
  if (remedy.input.kind === 'inline') {
    return ` To start a new run with a local agent worker: ${
      newRunCommand(remedy.path, remedy.input.argument, remedy.dataDir)}. ${PINS}`;
  }
  const requirement = ' A local agent worker is admitted at run start, so this run needs a new one.'
    + ` Starting one needs --local-agent, the flow path ${shellQuote(remedy.path)}, and the same`
    + ' --input this flow takes; ';
  return requirement + (remedy.input.kind === 'absent'
    ? 'the journal recorded no input argument to repeat here.'
    // Naming the size says which input, and says why this clause is prose:
    // the recorded value is larger than one `execve` argument may be, so a
    // printed `--input '<json>'` would fail before the CLI ran at all.
    : `the journal recorded ${remedy.input.bytes} bytes of input, more than a shell`
      + ' can carry in one argument, so pass the input file this run was started from.')
    + ` ${PINS}`;
}

/**
 * Which remedy an authored `.flow.ts` park gets, decided once for both authored
 * boundaries (`cli/direct-run.ts` on a fresh run, `resumeFlow` on a resume).
 *
 * The cause is trusted, not guessed: anything other than `worker_unavailable` —
 * including an absent cause — yields `none`, so a `needs_human` recovery wait is
 * never answered with "attach a worker", and an unclassified park says nothing
 * at all rather than something plausible.
 *
 * `path` is optional because the caller may only have the journal to go on. A
 * park with no known flow path yields `none` for the same reason an unknown
 * input yields prose: the point of this clause is a command someone can run.
 */
export function authoredWorkerRemedy(
  parkCause: ParkCause | undefined,
  attached: boolean,
  run: { path?: string; input: AuthoredInput; dataDir?: string },
): LocalAgentRemedy {
  if (parkCause !== 'worker_unavailable') return { kind: 'none' };
  if (attached) return { kind: 'attached' };
  if (run.path === undefined) return { kind: 'none' };
  return { kind: 'authored-run', path: run.path, input: run.input, dataDir: run.dataDir };
}

/**
 * `flows run --local-agent <path> [--input <input>] [--data-dir <dir>]`.
 *
 * The flag/path prefix is byte-for-byte what the spec-run message has always
 * emitted, so the one thing people already grep for still matches. `--input`
 * and `--data-dir` follow the path because the parser is order-insensitive
 * (cli.ts `parseRunArgs`), and keeping the prefix intact matters more than
 * mirroring the usage line's flag order.
 */
function newRunCommand(path: string, input: string | undefined, dataDir: string | undefined): string {
  return `flows run --local-agent ${shellQuote(path)}`
    + (input === undefined ? '' : ` --input ${shellQuote(input)}`)
    // `shellWord` here, matching `resumeCommand`/`answerCommand`: a data dir is
    // this machine's path, and the two renderings must not disagree.
    + (dataDir === undefined ? '' : ` --data-dir ${shellWord(dataDir)}`);
}
