// Bounded transcript tails: the last 64 KiB of an agent attempt's stdout and
// stderr, on disk beside its `pty.sock`.
//
// Nothing else holds the transcript. The worker buffers it in memory and
// publishes it live to the sidechannel; a failed agent attempt's output is
// nulled in the journal (machine.rs), leaving at most 2,000 chars of gate
// `detail`. So "why did my last attempt end" was unanswerable from disk.
//
// These files are evidence, not the record: best-effort, bounded, rewritten
// in place, never a reason for a step to fail. The journal remains truth.
// The file is raw; `flows status` redacts on read, which is the same trust
// boundary as `pty.sock` today (same OS user, mode 0600).

import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ptySocketPath } from './pty-sidechannel.js';
import { redact } from './redact.js';
import type { StepTails, TailSource, TranscriptTail } from './cli/status.js';
import type { StepView } from './run-state.js';

export const TAIL_CAPACITY_BYTES = 64 * 1024;
/** At most four rewrites a second, however fast the agent talks. */
export const TAIL_FLUSH_INTERVAL_MS = 250;
/**
 * How long a spawn's completion will wait for the final tail flush. Transcript
 * evidence is best-effort, so a stalled filesystem must cost the step this
 * much and no more — past it the invocation settles and the close runs on.
 */
export const TAIL_CLOSE_TIMEOUT_MS = 2_000;

export type TailStream = 'stdout' | 'stderr';

export interface TailIdentity {
  dataDir: string;
  runId: string;
  stepId: string;
  attempt: number;
}

/** The first line of every tail file, so a stale file is never mistaken for this attempt's. */
export interface TailHeader {
  v: 1;
  run_id: string;
  step_id: string;
  attempt: number;
  started_at_ms: number;
}

export function transcriptTailPath(identity: TailIdentity, stream: TailStream): string {
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 0) throw new Error('Invalid transcript tail attempt');
  return join(dirname(ptySocketPath(identity)), `attempt-${identity.attempt}.${stream}.tail`);
}

export interface TranscriptTailWriter {
  append(chunk: Buffer): void;
  /** Flush what is pending and stop. Resolves once the last write has settled, success or not. */
  close(): Promise<void>;
}

/**
 * A ring of the last {@link TAIL_CAPACITY_BYTES} bytes, flushed to
 * `attempt-<n>.<stream>.tail` at most every {@link TAIL_FLUSH_INTERVAL_MS}.
 * A write failure is reported once as a process warning and then ignored:
 * the attempt continues, and `flows status` will say no transcript is on disk.
 */
export function openTranscriptTail(
  identity: TailIdentity,
  stream: TailStream,
  startedAtMs = Date.now(),
  warn: (message: string) => void = (message) => process.emitWarning(message),
): TranscriptTailWriter {
  const path = transcriptTailPath(identity, stream);
  const header = JSON.stringify({ v: 1, run_id: identity.runId, step_id: identity.stepId, attempt: identity.attempt, started_at_ms: startedAtMs } satisfies TailHeader);
  const ring: Buffer[] = [];
  let ringBytes = 0;
  let dirty = false;
  let closed = false;
  let failed = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (!dirty || failed) return inFlight;
    dirty = false;
    const body = Buffer.concat([Buffer.from(`${header}\n`), ...ring]);
    inFlight = inFlight.then(async () => {
      // Write beside, then rename over: a reader never sees a torn file.
      const staging = `${path}.tmp`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(staging, 'w', 0o600);
      try { await file.writeFile(body); } finally { await file.close(); }
      await rename(staging, path);
    }).catch((error: unknown) => {
      if (failed) return;
      failed = true;
      warn(`Transcript tail for ${identity.runId}/${identity.stepId} attempt ${identity.attempt} (${stream}) could not be written; the step continues without it: ${error instanceof Error ? error.message : String(error)}`);
    });
    return inFlight;
  };

  return {
    append(chunk) {
      if (closed || failed || chunk.length === 0) return;
      if (chunk.length >= TAIL_CAPACITY_BYTES) {
        ring.splice(0, ring.length, Buffer.from(chunk.subarray(chunk.length - TAIL_CAPACITY_BYTES)));
        ringBytes = TAIL_CAPACITY_BYTES;
      } else {
        ring.push(Buffer.from(chunk));
        ringBytes += chunk.length;
        while (ringBytes > TAIL_CAPACITY_BYTES) {
          const excess = ringBytes - TAIL_CAPACITY_BYTES;
          const head = ring[0]!;
          if (head.length <= excess) { ring.shift(); ringBytes -= head.length; } else { ring[0] = head.subarray(excess); ringBytes -= excess; }
        }
      }
      dirty = true;
      if (timer === undefined) {
        timer = setTimeout(() => { timer = undefined; void flush(); }, TAIL_FLUSH_INTERVAL_MS);
        timer.unref();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      await flush();
    },
  };
}

/** A tail file parsed and checked against the attempt it claims to be. */
export interface ReadTail {
  header: TailHeader;
  /** Bytes of transcript on disk, after the header line. */
  bytes: number;
  text: string;
}

/**
 * Read one tail file. `undefined` when absent, unparseable, or written for a
 * different attempt — or for this attempt number but before the journal says
 * the attempt began, which is a file left by an earlier life of this data dir.
 */
export async function readTranscriptTail(
  identity: TailIdentity,
  stream: TailStream,
  attemptStartedAtMs: number | null,
): Promise<ReadTail | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(transcriptTailPath(identity, stream));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const newline = raw.indexOf(10);
  if (newline < 0) return undefined;
  let header: unknown;
  try { header = JSON.parse(raw.subarray(0, newline).toString('utf8')); } catch { return undefined; }
  if (header === null || typeof header !== 'object') return undefined;
  const claimed = header as Partial<TailHeader>;
  if (claimed.v !== 1 || claimed.run_id !== identity.runId || claimed.step_id !== identity.stepId
    || claimed.attempt !== identity.attempt || typeof claimed.started_at_ms !== 'number') return undefined;
  if (attemptStartedAtMs !== null && claimed.started_at_ms < attemptStartedAtMs) return undefined;
  const body = raw.subarray(newline + 1);
  return { header: claimed as TailHeader, bytes: body.length, text: body.toString('utf8') };
}

/**
 * Redact the whole tail before splitting it. A direct agent inherits the
 * worker's environment, so it can print a multiline secret; splitting first
 * meant no line held the whole value and `replaceAll` matched none of them.
 */
function lastLines(text: string, count: number, env: NodeJS.ProcessEnv): string[] {
  const lines = redact(text, env).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - count));
}

/** The {@link TailSource} `flows status` uses: this step's latest attempt, redacted. */
export function transcriptTailSource(env: NodeJS.ProcessEnv = process.env): TailSource {
  return {
    async read(dataDir: string, runId: string, step: StepView, lines: number): Promise<StepTails> {
      if (step.type !== 'agent' || step.attempt === 0) return null;
      const identity = { dataDir, runId, stepId: step.id, attempt: step.attempt };
      const tail = async (stream: TailStream): Promise<TranscriptTail | null> => {
        const read = await readTranscriptTail(identity, stream, step.started_at_ms);
        return read === undefined ? null : { attempt: step.attempt, bytes: read.bytes, lines: lastLines(read.text, lines, env) };
      };
      return { stdout: await tail('stdout'), stderr: await tail('stderr') };
    },
  };
}
