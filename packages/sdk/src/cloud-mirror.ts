// Mirroring a local run onto the Cloud dashboard, while it runs.
//
// A hosted run is watchable because something inside the sandbox reads its
// journal every few seconds and pushes what it finds. Nothing did that for a
// run started in a terminal, so a local run was invisible: the same flow, the
// same journal, the same evidence, and no page to look at. This is that
// reader, on the other side of the boundary.
//
// ## What it reads
//
// Only this run's journals. The sandbox reporter scans its whole data
// directory because a sandbox holds exactly one run; a developer's
// `~/.relayflowd` holds every run they have ever started, including other
// people's work in a shared checkout. So the set of journals is *derived*: the
// root, plus the child journals the root's own authored-step index names. A
// journal this run did not create is never opened, let alone uploaded.
//
// ## What it costs a run
//
// Nothing that can fail the run. Every push collapses to a boolean at the
// transport (`cloud-mirror-transport.ts`), each poll is bounded by its own
// deadline, and a poll that overruns is abandoned rather than allowed to grow
// with the flow. A journal that cannot be read keeps the previously cached
// view for that journal: a snapshot never gets emptier because a read failed.
//
// ## Ordering at the end
//
// The terminal callback is last, and that is load-bearing. Cloud revokes the
// run's credential when the run goes terminal, so the transcripts and the
// final step rows have to land before it — otherwise the mirror would report
// the run finished and then find itself unable to say what it did.

import { readFile, stat } from 'node:fs/promises';
import { walkJournal, JournalReadError, type JournalEvent } from './journal-reader.js';
import {
  fitSnapshot, mirrorJournal, withGraphHints,
  DEPENDS_ON_MAX_ENTRIES, SNAPSHOT_DEPENDS_ON_MAX, MAX_INT32,
  type FinalStep, type SnapshotStep,
} from './cloud-mirror-step.js';
import { MirrorClient, type MirrorEvent } from './cloud-mirror-transport.js';
import { redact } from './redact.js';

/** How often the journals are re-read. The sandbox reporter's own cadence. */
export const MIRROR_POLL_INTERVAL_MS = 10_000;
/** Whole-poll budget, independent of how many journals exist. */
export const MIRROR_POLL_BUDGET_MS = 8_000;
/** Budget for the final poll and every push that follows it. */
export const MIRROR_FINISH_BUDGET_MS = 30_000;
/** Republish an unchanged view this often, so a stalled view still looks fresh. */
export const MIRROR_SNAPSHOT_HEARTBEAT_MS = 120_000;
/** Final step rows one report carries; the rest are counted, not sent. */
export const MIRROR_MAX_FINAL_STEPS = 256;
/** Step views held across polls. Bounds the mirror, not the run. */
export const MIRROR_STEP_CACHE_MAX = 512;
/** Assembled `<stepName>/agent.log` cap, as the hosted executor uses. */
export const MIRROR_TRANSCRIPT_MAX_BYTES = 1024 * 1024;
/** Steps whose transcripts are uploaded. Beyond this the rows still land. */
export const MIRROR_MAX_TRANSCRIPT_UPLOADS = 64;
/** The run's own `runner.log`, as the `/logs` route serves it. */
export const MIRROR_RUNNER_LOG_MAX_BYTES = 256 * 1024;
/**
 * Re-reads of a journal a writer was mid-flight in, and the wait between.
 *
 * `walkJournal` copies the file and refuses a torn snapshot as `journal_busy`,
 * which on a *live* run is the ordinary case, not a fault — `flows status`
 * has always retried it for exactly that reason. Without the same policy the
 * mirror simply skipped a busy journal: a resume could not read the spec it
 * was about to register, so it registered nothing at all and the run stayed
 * off the dashboard.
 */
export const MIRROR_BUSY_RETRIES = 5;
export const MIRROR_BUSY_DELAY_MS = 50;
/** Journals one mirror will follow: the root, plus the children it admitted. */
export const MIRROR_MAX_JOURNALS = 4096;

export interface RunMirrorOptions {
  client: MirrorClient;
  /** The daemon data directory holding this run's journals. */
  dataDir: string;
  /** One line about the mirror itself; never about the run. */
  diagnostic?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  intervalMs?: number;
  pollBudgetMs?: number;
  snapshotHeartbeatMs?: number;
  /** Test seam: read one journal's events. */
  readJournal?: (runId: string, dataDir: string) => Promise<JournalEvent[]>;
  /** Test seam: read a transcript file. */
  readTranscript?: (path: string) => Promise<{ bytes: Buffer; size: number }>;
}

/** What the mirror was told about the run when it ended. */
export interface RunMirrorOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  /**
   * The run's own completion report, as the terminal callback stores it.
   *
   * Not decoration. Cloud reconciles a v2 run's reported status against this
   * document and records `failed` for anything that does not prove success —
   * the guard that stops a sandbox whose bootstrap exited cleanly from
   * reporting a run that died at step 1 as green. A mirror that sent a status
   * without the report was reconciled the other way, and a finished local run
   * showed up red. The run list also reads `completionReason` and
   * `pullRequestUrl` straight out of it.
   */
  result: Record<string, unknown>;
  completionReason?: string;
  error?: string;
  /** Lines the CLI printed for this run, uploaded as `runner.log`. */
  log?: readonly string[];
}

export interface RunMirror {
  readonly runId: string;
  readonly runUrl: string;
  /** Begin polling. The first poll runs on the first interval, not now. */
  start(rootRunId: string): void;
  /** One lifecycle event, pushed without waiting for the next poll. */
  event(event: MirrorEvent): void;
  /**
   * Stop polling, take one last reading, and publish the final report, the
   * transcripts and the terminal status — in that order. Never throws, and is
   * bounded by {@link MIRROR_FINISH_BUDGET_MS} however much is outstanding.
   */
  finish(outcome: RunMirrorOutcome): Promise<void>;
}

interface CachedStep {
  step: SnapshotStep;
  /** Journal order within its journal, so the published view reads top to bottom. */
  order: number;
  /** When this step's meaningful content last changed, for eviction. */
  changedAt: number;
}

/**
 * One consistent read of a journal, retrying only the mid-write case.
 *
 * Shared by the poller and by the resume path that reads a run's spec, so
 * both treat a writer being mid-flight the way `flows status` does. Every
 * other failure propagates unchanged: a corrupt journal is not a busy one.
 */
export async function readJournalEvents(
  runId: string,
  dataDir: string,
  sleep: (ms: number) => Promise<void> = ms => new Promise(done => { setTimeout(done, ms); }),
): Promise<JournalEvent[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const events: JournalEvent[] = [];
      for await (const event of walkJournal(runId, dataDir)) events.push(event);
      return events;
    } catch (error) {
      const busy = error instanceof JournalReadError && error.code === 'journal_busy';
      if (!busy || attempt >= MIRROR_BUSY_RETRIES) throw error;
      await sleep(MIRROR_BUSY_DELAY_MS);
    }
  }
}

async function defaultReadTranscript(path: string): Promise<{ bytes: Buffer; size: number }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('transcript is not a regular file');
  // Bound the read, not just the result: materializing a huge file only to
  // discard all but its tail can exhaust the CLI before it reports at all.
  if (info.size <= MIRROR_TRANSCRIPT_MAX_BYTES) {
    return { bytes: await readFile(path), size: info.size };
  }
  const handle = await (await import('node:fs/promises')).open(path, 'r');
  try {
    const buffer = Buffer.alloc(MIRROR_TRANSCRIPT_MAX_BYTES);
    const { bytesRead } = await handle.read(
      buffer, 0, MIRROR_TRANSCRIPT_MAX_BYTES, info.size - MIRROR_TRANSCRIPT_MAX_BYTES,
    );
    return { bytes: buffer.subarray(0, bytesRead), size: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * Assemble one step's attempts into the single object `/logs` serves.
 *
 * The frame vocabulary is Cloud's: each kept attempt is preceded by a
 * `relayflow.attempt` marker and a dropped one leaves a
 * `relayflow.attempt.omitted` marker in its place, so the dashboard's renderer
 * and `flows logs --step` read a mirrored transcript exactly as they read a
 * hosted one. A reader that sees fewer attempts than ran has been lied to.
 */
export async function assembleTranscript(
  attempts: ReadonlyArray<{ attempt: number; path: string }>,
  read: (path: string) => Promise<{ bytes: Buffer; size: number }>,
  maxBytes = MIRROR_TRANSCRIPT_MAX_BYTES,
): Promise<{ bytes: Buffer; kept: number; omitted: number; truncated: boolean }> {
  const ordered = [...attempts].sort((left, right) => left.attempt - right.attempt);
  const marker = (value: Record<string, unknown>): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const parts: Buffer[] = [];
  let total = 0;
  let kept = 0;
  let omitted = 0;
  let truncated = false;
  // Newest first: the last attempt is what the run's outcome rests on.
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const { attempt, path } = ordered[index]!;
    let read_: { bytes: Buffer; size: number };
    try {
      read_ = await read(path);
    } catch {
      // A missing attempt file is still an attempt that happened.
      parts.unshift(marker({ type: 'relayflow.attempt.omitted', attempt, bytes: 0 }));
      total += parts[0]!.length;
      omitted += 1;
      continue;
    }
    const reserve = 128 * (index + 1);
    if (kept > 0 && read_.bytes.length > maxBytes - total - reserve) {
      parts.unshift(marker({ type: 'relayflow.attempt.omitted', attempt, bytes: read_.size }));
      total += parts[0]!.length;
      omitted += 1;
      continue;
    }
    let content = read_.bytes;
    let cut = read_.size > content.length;
    const cap = maxBytes - reserve;
    if (content.length > cap) {
      content = content.subarray(content.length - cap);
      cut = true;
    }
    if (cut) {
      // A tail cut lands mid-frame and this object is parsed as JSONL: open on
      // the first WHOLE frame rather than a broken one. A file with no newline
      // is one frame, so there is nothing to snap to and it is left as it is.
      const firstFrame = content.indexOf(0x0a);
      if (firstFrame >= 0 && firstFrame + 1 < content.length) content = content.subarray(firstFrame + 1);
      truncated = true;
    }
    const head = marker({ type: 'relayflow.attempt', attempt, bytes: content.length, truncated: cut });
    const body = content.length > 0 && content[content.length - 1] !== 0x0a
      ? Buffer.concat([content, Buffer.from('\n')])
      : content;
    parts.unshift(head, body);
    total += head.length + body.length;
    kept += 1;
  }
  return { bytes: Buffer.concat(parts), kept, omitted, truncated };
}

export function createRunMirror(options: RunMirrorOptions): RunMirror {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? MIRROR_POLL_INTERVAL_MS;
  const pollBudgetMs = options.pollBudgetMs ?? MIRROR_POLL_BUDGET_MS;
  const heartbeatMs = options.snapshotHeartbeatMs ?? MIRROR_SNAPSHOT_HEARTBEAT_MS;
  const readJournal = options.readJournal ?? readJournalEvents;
  const readTranscript = options.readTranscript ?? defaultReadTranscript;
  const diagnostic = options.diagnostic ?? ((): void => {});

  /** The journals this run owns: the root, and every child its index names. */
  const journals: string[] = [];
  const known = new Set<string>();
  const finished = new Set<string>();
  const steps = new Map<string, CachedStep>();
  /** Final rows by `<journal>/<step>`, so two journals cannot collide on a step id. */
  const finals = new Map<string, { journalRunId: string; row: FinalStep }>();
  const transcripts = new Map<string, { stepName: string; attempts: Array<{ attempt: number; path: string }> }>();
  const hints = new Map<string, { label?: string; after?: string[] }>();
  /** Live steps the cache cap dropped, by identity, so a capped view owns up to it. */
  const evicted = new Set<string>();
  /** Finished steps past the report cap, by identity. Counted, never sent. */
  const unreported = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let stopped = false;
  let sequence = 0;
  let acknowledged: string | undefined;
  let acknowledgedAt = now();

  const admit = (runId: string): void => {
    // Far above any real authored run, and a bound all the same: the child
    // list comes out of a journal, and a reader of a journal bounds what it
    // will grow to hold.
    if (known.has(runId) || journals.length >= MIRROR_MAX_JOURNALS) return;
    known.add(runId);
    journals.push(runId);
  };

  const remember = (journalRunId: string, step: SnapshotStep, order: number): void => {
    const key = `${journalRunId}/${step.stepName}`;
    const existing = steps.get(key);
    const changed = existing === undefined || fingerprint(existing.step) !== fingerprint(step);
    steps.set(key, { step, order, changedAt: changed ? now() : existing!.changedAt });
    evicted.delete(key);
    while (steps.size > MIRROR_STEP_CACHE_MAX) {
      // Evict the least recently changed *completed* step first: the live work
      // is the whole point of a live view.
      const victim = [...steps.entries()].sort(comparePriority).pop();
      if (victim === undefined) break;
      steps.delete(victim[0]);
      evicted.add(victim[0]);
    }
  };

  const scan = async (deadline: number): Promise<void> => {
    // Index-based, over the live array: a child journal the root's index names
    // is appended during this very pass, and a run whose only steps are its
    // children would otherwise publish nothing until the next poll — which for
    // a short run is never, because `finish` scans once.
    for (let index = 0; index < journals.length; index += 1) {
      const runId = journals[index]!;
      if (now() > deadline) break;
      if (finished.has(runId)) continue;
      let events: JournalEvent[];
      try {
        events = await readJournal(runId, options.dataDir);
      } catch (error) {
        // Two ordinary conditions, neither worth a line on someone's terminal
        // once a poll: `run_not_found`, because a child journal is named in
        // the index the moment its step is admitted and that can precede the
        // file; and `journal_busy` past its retries, because a hot journal is
        // what a running flow looks like. Both keep the cached view.
        const ordinary = error instanceof JournalReadError
          && (error.code === 'run_not_found' || error.code === 'journal_busy');
        if (!ordinary) {
          diagnostic(`could not read journal ${runId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      let folded;
      try {
        folded = mirrorJournal(runId, events, now(), env);
      } catch (error) {
        diagnostic(`could not fold journal ${runId}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const child of folded.children) admit(child);
      for (const [key, hint] of folded.hints) {
        // Merge, never replace: a completion record can omit a label or an
        // edge the admission carried, and the view must not lose a step's
        // name between them.
        const existing = hints.get(key);
        hints.set(key, {
          ...(hint.label ?? existing?.label ? { label: hint.label ?? existing?.label } : {}),
          ...(hint.after ?? existing?.after ? { after: hint.after ?? existing?.after } : {}),
        });
      }
      folded.steps.forEach((step, order) => remember(runId, step, order));
      for (const row of folded.finals) {
        const key = `${runId}/${row.stepName}`;
        // The report cap bounds what this process holds, not just what it
        // sends: a run with ten thousand steps must not grow its own mirror.
        // Steps past it are counted by identity, so a step read twice is one
        // missing step and not two.
        if (!finals.has(key) && finals.size >= MIRROR_MAX_FINAL_STEPS) {
          unreported.add(key);
          continue;
        }
        finals.set(key, { journalRunId: runId, row });
      }
      for (const ref of folded.transcripts) {
        if (!finals.has(`${runId}/${ref.stepName}`)) continue;
        transcripts.set(`${runId}/${ref.stepName}`, { stepName: ref.stepName, attempts: ref.attempts });
      }
      if (folded.terminal) finished.add(runId);
    }
  };

  /** The cached view in display order: journal order, journal by journal. */
  const ordered = (): SnapshotStep[] => {
    const names = new Set([...steps.values()].map(entry => entry.step.stepName));
    return [...steps.entries()]
      .sort(([leftKey, left], [rightKey, right]) => {
        const journal = leftKey.split('/')[0]!.localeCompare(rightKey.split('/')[0]!);
        return journal !== 0 ? journal : left.order - right.order;
      })
      .map(([, entry]) => withGraphHints(
        entry.step, hints, entry.step.journalRunId, SNAPSHOT_DEPENDS_ON_MAX, names,
      ));
  };

  const publishSnapshot = async (deadline: number): Promise<void> => {
    const view = ordered();
    if (view.length === 0) return;
    // `elapsedMs` moves every poll and is excluded from the comparison, or the
    // throttle would degenerate into "push every interval".
    const print = view.map(fingerprint).join('|');
    if (print === acknowledged && now() - acknowledgedAt < heartbeatMs) return;
    sequence += 1;
    const snapshot = fitSnapshot(view, {
      sequence,
      capturedAt: new Date(now()).toISOString(),
      alreadyOmitted: evicted.size,
    });
    const budget = deadline - now();
    if (budget <= 0) return;
    if (await options.client.publishSnapshot(snapshot, { timeoutMs: budget })) {
      acknowledged = print;
      acknowledgedAt = now();
    }
  };

  const poll = async (budgetMs: number): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      const deadline = now() + budgetMs;
      await scan(deadline);
      await publishSnapshot(deadline);
    } catch (error) {
      diagnostic(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      polling = false;
    }
  };

  const uploadTranscripts = async (deadline: number): Promise<void> => {
    let uploaded = 0;
    for (const [key, ref] of transcripts) {
      if (uploaded >= MIRROR_MAX_TRANSCRIPT_UPLOADS || now() > deadline) break;
      const entry = finals.get(key);
      if (entry === undefined) continue;
      let assembled;
      try {
        assembled = await assembleTranscript(ref.attempts, readTranscript);
      } catch (error) {
        diagnostic(`could not assemble the transcript for ${ref.stepName}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (assembled.bytes.length === 0) continue;
      // Name the row after the object only once the object is there, so no row
      // ever points at a transcript that was never written.
      if (await options.client.putObject(`${ref.stepName}/agent.log`, assembled.bytes)) {
        finals.set(key, { ...entry, row: { ...entry.row, sandboxId: ref.stepName } });
        uploaded += 1;
      }
    }
  };

  const publishFinal = async (deadline: number): Promise<void> => {
    const sent = [...finals.values()];
    // A capped report says how many steps it left out. A run page that shows
    // 256 of 400 steps without saying so is worse than one that shows none.
    const omitted = Math.min(unreported.size, MAX_INT32);
    const names = new Set(sent.map(entry => entry.row.stepName));
    const withGraph = sent.map(entry =>
      withGraphHints(entry.row, hints, entry.journalRunId, DEPENDS_ON_MAX_ENTRIES, names));
    if (now() > deadline) return;
    if (!await options.client.publishSteps(withGraph, omitted)) {
      diagnostic('Cloud did not accept the final step report; the run page keeps its live view');
    }
  };

  return {
    get runId() { return options.client.runId; },
    get runUrl() { return options.client.runUrl; },
    start(rootRunId) {
      admit(rootRunId);
      if (timer !== undefined || stopped) return;
      timer = setInterval(() => { void poll(pollBudgetMs); }, intervalMs);
      // Never hold the process open for an observation.
      timer.unref?.();
    },
    event(event) {
      void options.client.publishEvent(event);
    },
    async finish(outcome) {
      if (timer !== undefined) { clearInterval(timer); timer = undefined; }
      const deadline = now() + MIRROR_FINISH_BUDGET_MS;
      try {
        // One last reading, so the page shows the run's actual last moments
        // rather than whatever the previous poll happened to catch.
        await scan(deadline);
        await publishSnapshot(deadline);
        if (outcome.log !== undefined && outcome.log.length > 0) {
          // The CLI's own output, redacted on the way out. It is not a
          // transcript the worker already scrubbed: it is whatever this
          // invocation printed on a developer's machine, including diagnostics
          // that can quote a command line or an environment value.
          const bytes = Buffer.from(redact(outcome.log.join('\n'), env), 'utf8');
          await options.client.putObject('runner.log',
            bytes.length > MIRROR_RUNNER_LOG_MAX_BYTES
              ? bytes.subarray(bytes.length - MIRROR_RUNNER_LOG_MAX_BYTES)
              : bytes);
        }
        await uploadTranscripts(deadline);
        await publishFinal(deadline);
        // Last, always: this transition revokes the credential every call
        // above depends on.
        await options.client.reportTerminal(
          outcome.status,
          redactJson(outcome.result, env) as Record<string, unknown>,
          outcome.error,
        );
      } catch (error) {
        diagnostic(`could not finish the mirror: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        stopped = true;
      }
    },
  };
}

/**
 * Redact every string the report carries, leaf by leaf.
 *
 * Not `redact(JSON.stringify(...))`: the redactor's value patterns end in
 * `\\S+`, which across serialized JSON would swallow the closing quote and the
 * next key, and hand Cloud a document it cannot parse. Redacting leaves keeps
 * the shape intact and still scrubs every free-text field.
 */
function redactJson(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return redact(value, env);
  if (Array.isArray(value)) return value.map(entry => redactJson(entry, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactJson(entry, env)]),
    );
  }
  return value;
}

/** Everything about a step but its ever-moving elapsed time. */
function fingerprint(step: SnapshotStep): string {
  const { elapsedMs: _elapsedMs, ...rest } = step;
  return JSON.stringify(rest);
}

/** Least recently changed first, and a running step is never the first victim. */
function comparePriority(
  [, left]: [string, CachedStep],
  [, right]: [string, CachedStep],
): number {
  const liveness = Number(left.step.state === 'done') - Number(right.step.state === 'done');
  return liveness !== 0 ? liveness : right.changedAt - left.changedAt;
}
