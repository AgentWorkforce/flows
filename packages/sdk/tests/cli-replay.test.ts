import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { walkJournal, type JournalEvent } from '../src/journal-client.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const CLI = join(ROOT, 'packages/sdk/dist/cli.js');
// Captured from a real completed kernel run; replay must not execute its
// recorded agent command or its 35-second deterministic command.
const EVENTS = readFileSync(join(ROOT, 'docs/evidence/journal-close-0909/completed.journal.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as JournalEvent);
const RUN_ID = EVENTS[0]!.run_id;
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cli-replay-'));
  directories.push(directory);
  return directory;
}

function fixture(events = EVENTS, wal = false): { dataDir: string; path: string; writer: Database } {
  const dataDir = temporaryDirectory();
  mkdirSync(join(dataDir, 'runs'));
  const path = join(dataDir, 'runs', `${RUN_ID}.sqlite3`);
  const writer = new DatabaseSync(path);
  if (wal) writer.exec('PRAGMA journal_mode = WAL');
  // Persist the real envelope using the schema in relayflowd-journal/src/lib.rs.
  writer.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO meta VALUES ('run_id', '${RUN_ID}'), ('journal_version', '1');
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
  return { dataDir, path, writer };
}

async function replay(dataDir: string, extra: string[] = [], runId = RUN_ID) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(['replay', '--data-dir', dataDir, runId, ...extra], {
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

function diskState(directory: string): unknown {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const info = statSync(path);
    return [name, info.mtimeMs, info.isDirectory() ? diskState(path) : createHash('sha256').update(readFileSync(path)).digest('hex')];
  });
}

describe('flows replay', () => {
  it('full walk emits every journal event in order through the terminal event without a daemon or writes', async () => {
    const { dataDir, writer } = fixture(EVENTS, true);
    writer.close();
    const before = diskState(dataDir);
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('replay opened a socket'); });
    const json = await replay(dataDir, ['--json']);
    expect(json.code).toBe(0);
    expect(json.stderr).toEqual([]);
    expect(json.stdout.map((line) => JSON.parse(line).event)).toEqual(EVENTS);
    expect(JSON.parse(json.stdout.at(-1)!).kind).toBe('run.completed');
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({ step_id: null, kind: 'run.spawned', verification: null, spend: null });
    const completedPayload = EVENTS[3]!.payload as Record<string, unknown>;
    expect(JSON.parse(json.stdout[3]!)).toEqual({
      step_id: 'implement', kind: 'step.completed', event: EVENTS[3],
      verification: completedPayload['verification'], spend: completedPayload['budget'],
    });
    const text = await replay(dataDir);
    expect(text.code).toBe(0);
    expect(text.stderr).toEqual([]);
    expect(text.stdout).toHaveLength(EVENTS.length);
    EVENTS.forEach((event, index) => expect(text.stdout[index]).toContain(`${event.seq} ${event.at_ms} ${event.entry_type}`));
    expect(text.stdout.every((line) => !line.includes('\n'))).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect(diskState(dataDir)).toEqual(before);
  });

  it('--at emits the full-walk prefix inclusive of the requested step', async () => {
    const { dataDir, writer } = fixture();
    writer.close();
    for (const flags of [[], ['--json']]) {
      const full = await replay(dataDir, flags);
      const prefix = await replay(dataDir, [...flags, '--at', 'verify']);
      expect(prefix.code).toBe(0);
      expect(prefix.stderr).toEqual([]);
      expect(prefix.stdout).toEqual(full.stdout.slice(0, 7));
      expect(prefix.stdout.at(-1)).toContain('step.completed');
    }
  });

  it('--json is byte-identical across two CLI invocations (diff)', () => {
    const { dataDir, writer } = fixture();
    writer.close();
    const outputs = [0, 1].map((index) => {
      const result = spawnSync(process.execPath, [CLI, 'replay', '--json', '--data-dir', dataDir, RUN_ID], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n').map((line) => JSON.parse(line).event)).toEqual(EVENTS);
      const path = join(dataDir, `replay-${index}.jsonl`);
      writeFileSync(path, result.stdout);
      return path;
    });
    const diff = spawnSync('diff', ['-u', ...outputs], { encoding: 'utf8' });
    expect(diff.status, diff.stderr).toBe(0);
    expect(diff.stdout).toBe('');
  });

  it('refuses run_not_found without creating a data directory', async () => {
    const dataDir = join(temporaryDirectory(), 'absent');
    const output = await replay(dataDir, ['--json']);
    expect(output.code).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain('REFUSED [run_not_found]');
    expect(readdirSync(dirname(dataDir))).toEqual([]);
  });

  it('refuses step_not_found before emitting journal events', async () => {
    const { dataDir, writer } = fixture();
    writer.close();
    const output = await replay(dataDir, ['--at', 'absent']);
    expect(output.code).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain('REFUSED [step_not_found]');
  });

  it.each(['../escape', '/absolute', 'a/b', 'a\\b', '.', '..', 'bad\nname', ''])('refuses invalid_run_id: %j', async (runId) => {
    const output = await replay(temporaryDirectory(), [], runId);
    expect(output.code).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain('REFUSED [invalid_run_id]');
  });

  it('refuses journal_read_failed for a corrupted journal', async () => {
    const { dataDir, path, writer } = fixture();
    writer.close();
    const bytes = readFileSync(path);
    bytes[0] = 0xff;
    writeFileSync(path, bytes);
    const output = await replay(dataDir, ['--json']);
    expect(output.code).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain('REFUSED [journal_read_failed]');
    expect(output.stderr[0]).toContain('byte offset 0');
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('reads committed WAL events without changing the live database or sidecars', async () => {
    const { dataDir, writer } = fixture(EVENTS, true);
    try {
      const before = diskState(dataDir);
      const output = await replay(dataDir, ['--json']);
      expect(output.code).toBe(0);
      expect(output.stdout.map((line) => JSON.parse(line).event)).toEqual(EVENTS);
      expect(diskState(dataDir)).toEqual(before);
    } finally { writer.close(); }
  });

  it('walks all segments and includes all retries when stopping at a step', async () => {
    const { dataDir, writer } = fixture();
    writer.exec("INSERT INTO segments VALUES (2, 1, 8); UPDATE entries SET segment_id = 2 WHERE seq >= 8; UPDATE entries SET step_id = 'verify', attempt = 2 WHERE seq BETWEEN 8 AND 10; UPDATE entries SET payload = json_set(payload, '$.disposition', 'retry') WHERE seq = 7");
    writer.close();
    const output = await replay(dataDir, ['--json', '--at', 'verify']);
    expect(output.code).toBe(0);
    const events = output.stdout.map((line) => JSON.parse(line).event);
    expect(events).toHaveLength(10);
    expect(events.at(-1)).toMatchObject({ seq: 10, segment_id: 2, step_id: 'verify', attempt: 2 });
  });

  it('stops at the terminal completion even if a later channel record references the step', async () => {
    const { dataDir, writer } = fixture();
    writer.exec("UPDATE entries SET step_id = 'verify', entry_type = 'channel.acknowledged' WHERE seq = 10");
    writer.close();
    const output = await replay(dataDir, ['--json', '--at', 'verify']);
    expect(output.code).toBe(0);
    expect(output.stdout.map((line) => JSON.parse(line).event)).toEqual(EVENTS.slice(0, 7));
  });

  it.each([false, true])('returns exit 1 and a byte offset after a mid-journal parse error (WAL=%s)', async (wal) => {
    const { dataDir, path, writer } = fixture(EVENTS, wal);
    writer.exec("UPDATE entries SET payload = '{' WHERE seq = 7");
    if (!wal) writer.close();
    try {
      const output = await replay(dataDir, ['--json']);
      expect(output.code).toBe(1);
      expect(output.stdout.map((line) => JSON.parse(line).event)).toEqual(EVENTS.slice(0, 6));
      expect(output.stderr[0]).toContain('FAILED [journal_read_failed]');
      expect(output.stderr[0]).toContain('Entry seq 7');
      const location = output.stderr[0]!.match(/(journal|WAL) byte offset (\d+)/);
      expect(location).not.toBeNull();
      const bytes = readFileSync(location![1] === 'WAL' ? `${path}-wal` : path);
      expect(Number(location![2])).toBeLessThan(bytes.length);
      // The cell contains this record's kind and invalid JSON payload.
      expect(bytes.subarray(Number(location![2]), Number(location![2]) + 100).toString()).toContain('step.completed');
    } finally { if (wal) writer.close(); }
  });

  it('refuses a journal that changes while the snapshot is copied', async () => {
    const { dataDir, path, writer } = fixture();
    writer.close();
    const originalCopy = fsPromises.copyFile;
    vi.spyOn(fsPromises, 'copyFile').mockImplementation(async (source, destination, mode) => {
      await originalCopy(source, destination, mode);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('changed')]));
    });
    const output = await replay(dataDir);
    expect(output.code).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain('Journal changed while taking the replay snapshot');
  });

  it('can stop at an unfinished step and release the walker early', async () => {
    const { dataDir, writer } = fixture(EVENTS.slice(0, 6));
    writer.close();
    const output = await replay(dataDir, ['--json', '--at', 'verify']);
    expect(output.code).toBe(0);
    expect(output.stdout.map((line) => JSON.parse(line).event)).toEqual(EVENTS.slice(0, 6));
    for await (const event of walkJournal(RUN_ID, dataDir)) {
      expect(event).toEqual(EVENTS[0]);
      break;
    }
  });

  it.each([
    "UPDATE meta SET value = 'wrong-run' WHERE key = 'run_id'",
    "UPDATE meta SET value = '999' WHERE key = 'journal_version'",
    "UPDATE entries SET payload = '{' WHERE seq = 1",
    "UPDATE entries SET at_ms = 9223372036854775807 WHERE seq = 1",
    "UPDATE entries SET entry_type = 'unknown.record' WHERE seq = 1",
  ])('fails closed on invalid journal contents: %s', async (sql) => {
    const { dataDir, writer } = fixture();
    writer.exec(sql);
    writer.close();
    const output = await replay(dataDir);
    expect(output.code).toBe(2);
    expect(output.stderr[0]).toContain('REFUSED [journal_read_failed]');
  });

  it.each([
    [], [RUN_ID, '--at'], [RUN_ID, '--data-dir'], [RUN_ID, '--no-spawn'],
    [RUN_ID, '--json', '--json'], [RUN_ID, '--at', 'x', '--at', 'y'],
    [RUN_ID, '--data-dir', 'x', '--data-dir', 'y'], [RUN_ID, 'extra'],
  ].map((args) => ({ args })))('refuses invalid invocation $args', async ({ args }) => {
    const stderr: string[] = [];
    expect(await runCli(['replay', ...args], { stdout: () => {}, stderr: (line) => stderr.push(line) })).toBe(2);
    expect(stderr.join('\n')).toContain('REFUSED [invalid_invocation]');
  });
});
