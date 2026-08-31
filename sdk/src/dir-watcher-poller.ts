/**
 * Directory watcher -> relayflow events.
 *
 * Second proactive workload on gate 2 primitives (hn-monitor is the first).
 * Deliberately non-provider: no HTTP, no API tokens, no gate-6 dependency —
 * just a directory poll. This proves the runner pattern generalizes beyond
 * `hn-poller` without regressing RFC-0001 §6 (which assigns providers to
 * relayfile adapters, not SDK code).
 *
 * How it works: each poll lists the target directory, dedupes against a
 * caller-supplied `seen` set (or an internal Map if none provided), and
 * submits a `dir.file_appeared` event for each unseen entry through the
 * journal protocol. The kernel then dispatches the flow's agent step for
 * each new file.
 *
 * Deduplication is still ultimately the kernel's job (flow's
 * `dedupeKeyTemplate` + the (flow, subscription, key) claim). This layer's
 * `seen` set is a cheap pre-filter so we don't spam `event.submit` with the
 * same paths on every poll — an optimization, not a correctness contract.
 *
 * Real-world analog: an "inbox" directory that a human or another system
 * drops files into, triggering a per-file flow (summarize, ingest, route,
 * whatever the step declares).
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/** Anything that can submit an event through the journal protocol. */
export interface EventSink {
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
}

/** Injected so I/O stays deterministic in tests. */
export interface DirLister {
  (dir: string): Promise<Array<{ name: string; size: number; mtimeMs: number; isFile: boolean }>>;
}

const defaultLister: DirLister = async (dir) => {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: Array<{ name: string; size: number; mtimeMs: number; isFile: boolean }> = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = join(dir, ent.name);
    const stat = await fsp.stat(full);
    out.push({
      name: ent.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      isFile: true,
    });
  }
  return out;
};

export interface PollOptions {
  /** Directory to watch. Required. */
  dir: string;
  /**
   * Set of relative paths already seen. The poller mutates it, adding each
   * new file it submits. Callers persist this across polls to avoid
   * re-submitting; internal callers can pass a fresh Set each poll if
   * they'd rather rely on the kernel's dedupe claim.
   */
  seen: Set<string>;
  /**
   * Lister override — tests inject a deterministic fake. Production uses
   * fs.readdir.
   */
  lister?: DirLister;
  /**
   * Cap on files per poll (safety valve against dropping thousands into
   * the directory at once). Default 100.
   */
  fileLimit?: number;
}

const DEFAULT_FILE_LIMIT = 100;

/**
 * List the directory once and submit a `dir.file_appeared` event for each
 * unseen file. Adds each submitted path to `seen`.
 *
 * Returns the submit outcomes (one per new file). Journal errors from
 * `eventSubmit` propagate; empty result is not an error; a missing
 * directory throws (the caller decides whether that's a fetch error or
 * a real failure — the runner classifies).
 */
export async function pollDirectoryOnce(
  spec: unknown,
  sink: EventSink,
  options: PollOptions,
): Promise<unknown[]> {
  const lister = options.lister ?? defaultLister;
  const fileLimit = options.fileLimit ?? DEFAULT_FILE_LIMIT;
  const seen = options.seen;

  const entries = await lister(options.dir);
  const fresh = entries
    .filter((e) => e.isFile && !seen.has(e.name))
    .slice(0, fileLimit);

  const outcomes: unknown[] = [];
  for (const entry of fresh) {
    outcomes.push(
      await sink.eventSubmit(spec, {
        type: 'dir.file_appeared',
        payload: {
          type: 'file',
          path: entry.name,
          size: entry.size,
          mtime_ms: entry.mtimeMs,
        },
      }),
    );
    // Only add to `seen` AFTER a successful submit — a journal failure
    // means the event didn't reach the kernel, so the next poll should
    // retry submission.
    seen.add(entry.name);
  }
  return outcomes;
}
