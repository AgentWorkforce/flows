import { constants } from 'node:fs';
import { copyFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { journalRecordOffset } from './journal-offset.js';

// Journal version 1's closed vocabulary (relayflowd-core/src/entry.rs).
const ENTRY_TYPES = new Set([
  'run.spawned', 'run.cancel.requested', 'event.received', 'subscription.registered',
  'subscription.matched', 'subscription.stale', 'step.routed', 'step.attempt.started',
  'step.completed', 'wait.event', 'wait.human', 'sleep.until', 'wait.completed',
  'stream.appended', 'memory.injected', 'channel.appended', 'channel.delivered',
  'channel.acknowledged', 'effect.recorded', 'effect.confirmed', 'epoch.summary',
  'segment.closed', 'run.completed',
]);

/** The persisted envelope from relayflowd-core/src/entry.rs. */
export interface JournalEvent {
  seq: number;
  segment_id: number;
  entry_type: string;
  run_id: string;
  step_id: string | null;
  attempt: number | null;
  at_ms: number;
  payload: unknown;
}

export type JournalReadFailure =
  | 'invalid_run_id' | 'run_not_found' | 'step_not_found' | 'journal_read_failed';

export class JournalReadError extends Error {
  constructor(readonly code: JournalReadFailure, message: string) {
    super(message);
    this.name = 'JournalReadError';
  }
}

async function fingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) throw new Error(`Journal path is not a regular file: ${path}`);
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Walk a stable on-disk journal in sequence order, across every segment.
 * `at` includes the step's terminal completion, or its last journaled event
 * if it has not terminated. Retries are included.
 *
 * SQLite read-only connections can still create/change WAL shared-memory files.
 * Copy the database and its WAL into private scratch space before opening it,
 * and reject concurrent source changes instead of returning a torn snapshot.
 * Only scratch files are written; the run, registry and daemon are untouched.
 */
export async function* walkJournal(
  runId: string,
  dataDir: string,
  options: { at?: string } = {},
): AsyncIterable<JournalEvent> {
  // Run ids are path components, never paths. Permit imported run names as
  // well as the ULIDs produced by the kernel.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) {
    throw new JournalReadError('invalid_run_id', 'Run id must contain only letters, digits, underscores or hyphens, starting with a letter or digit.');
  }
  const source = join(resolve(dataDir), 'runs', `${runId}.sqlite3`);
  let scratch: string | undefined;
  let database: import('node:sqlite').DatabaseSync | undefined;
  try {
    const before = await Promise.all([fingerprint(source), fingerprint(`${source}-wal`)]);
    if (before[0] === undefined) {
      throw new JournalReadError('run_not_found', `Run "${runId}" does not exist in "${dataDir}".`);
    }
    scratch = await mkdtemp(join(tmpdir(), 'flows-replay-'));
    const snapshot = join(scratch, 'journal.sqlite3');
    await copyFile(source, snapshot, constants.COPYFILE_EXCL);
    if (before[1] !== undefined) await copyFile(`${source}-wal`, `${snapshot}-wal`, constants.COPYFILE_EXCL);
    const after = await Promise.all([fingerprint(source), fingerprint(`${source}-wal`)]);
    if (before.some((value, index) => value !== after[index])) {
      throw new Error('Journal changed while taking the replay snapshot; retry replay.');
    }
    const file = await open(snapshot, 'r');
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await file.read(header, 0, 16, 0);
      const expected = Buffer.from('SQLite format 3\0');
      for (let offset = 0; offset < expected.length; offset += 1) {
        if (offset >= bytesRead || header[offset] !== expected[offset]) {
          throw new Error(`Invalid SQLite header at journal byte offset ${offset}.`);
        }
      }
    } finally { await file.close(); }

    // Lazy loading keeps all existing CLI verbs independent of node:sqlite.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    database = new DatabaseSync(snapshot, { readOnly: true });
    const metadata = database.prepare("SELECT value FROM meta WHERE key = 'run_id'").get();
    if (metadata?.['value'] !== runId) throw new Error('Journal run id does not match the requested run.');
    const version = database.prepare("SELECT value FROM meta WHERE key = 'journal_version'").get();
    if (version?.['value'] !== '1') throw new Error('Unsupported journal version.');
    const integrity = database.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0]?.['quick_check'] !== 'ok') throw new Error('Journal integrity check failed.');

    let through: number | undefined;
    if (options.at !== undefined) {
      const row = database.prepare(`
        SELECT COALESCE(MAX(CASE WHEN entry_type = 'step.completed'
          AND json_valid(payload) AND json_extract(payload, '$.disposition') IN ('step_done', 'park')
          THEN seq END), MAX(seq)) AS seq FROM entries WHERE step_id = ?
      `).get(options.at);
      if (row?.['seq'] === null || row === undefined) {
        throw new JournalReadError('step_not_found', `Step "${options.at}" is not journaled in run "${runId}".`);
      }
      through = integer(row['seq'], 'seq');
    }
    const rows = database.prepare(
      'SELECT seq, segment_id, entry_type, step_id, attempt, at_ms, payload FROM entries'
        + (through === undefined ? '' : ' WHERE seq <= ?') + ' ORDER BY seq',
    ).iterate(...(through === undefined ? [] : [through]));
    for (const row of rows) {
      try {
        if (typeof row['entry_type'] !== 'string' || !ENTRY_TYPES.has(row['entry_type'])
          || typeof row['payload'] !== 'string'
          || (row['step_id'] !== null && typeof row['step_id'] !== 'string')) {
          throw new Error('Invalid journal entry or unknown record type.');
        }
        yield {
          seq: integer(row['seq'], 'seq'),
          segment_id: integer(row['segment_id'], 'segment_id'),
          entry_type: row['entry_type'],
          run_id: runId,
          step_id: row['step_id'],
          attempt: row['attempt'] === null ? null : integer(row['attempt'], 'attempt'),
          at_ms: integer(row['at_ms'], 'at_ms'),
          payload: JSON.parse(row['payload']),
        };
      } catch (error) {
        const root = database.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'entries'").get();
        const location = journalRecordOffset(snapshot, integer(root?.['rootpage'], 'rootpage'), integer(row['seq'], 'seq'));
        throw new Error(`Entry seq ${row['seq']} at ${location}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    if (error instanceof JournalReadError) throw error;
    throw new JournalReadError('journal_read_failed', `Cannot read journal for run "${runId}": ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      database?.close();
    } finally {
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    }
  }
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid journal ${field}: expected a safe integer.`);
  }
  return value;
}
