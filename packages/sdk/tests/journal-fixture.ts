// A real SQLite journal on disk, in the schema relayflowd-journal/src/lib.rs
// writes, from a list of journal events. Shared by the read-side CLI tests
// (`replay`, `status`) so they read what the kernel would have written.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';
import type { JournalEvent } from '../src/journal-client.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function writeJournalFixture(
  dataDir: string,
  runId: string,
  events: readonly JournalEvent[],
  wal = false,
): { path: string; writer: Database } {
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  const path = join(dataDir, 'runs', `${runId}.sqlite3`);
  const writer = new DatabaseSync(path);
  if (wal) writer.exec('PRAGMA journal_mode = WAL');
  writer.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO meta VALUES ('run_id', '${runId}'), ('journal_version', '1');
    CREATE TABLE segments (segment_id INTEGER PRIMARY KEY, journal_version INTEGER NOT NULL, opened_seq INTEGER NOT NULL);
    INSERT INTO segments VALUES (1, 1, 1);
    CREATE TABLE entries (
      seq INTEGER PRIMARY KEY, segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
      entry_type TEXT NOT NULL, step_id TEXT, attempt INTEGER, at_ms INTEGER NOT NULL, payload TEXT NOT NULL
    );
  `);
  const insert = writer.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const event of events) {
    insert.run(event.seq, event.segment_id, event.entry_type, event.step_id, event.attempt, event.at_ms, JSON.stringify(event.payload));
  }
  return { path, writer };
}
