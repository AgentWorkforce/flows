// node testdata/memory/seed.mjs <db-path> <script-scope>
// Creates an ai-hist 0.63 database and two history prompts. No cloud or host history.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(new URL('../../packages/sdk/package.json', import.meta.url));
const { migrateStore } = await import(pathToFileURL(require.resolve('ai-hist')).href);
const [path, scope] = process.argv.slice(2);
if (!path || !scope) throw new Error('expected database path and script scope');
await migrateStore({ dbPath: path });
const db = new DatabaseSync(path);
// One file, so a later digest of the database is not a stale wal snapshot.
db.exec('PRAGMA journal_mode = DELETE');
const insert = db.prepare(
  'INSERT INTO history (source, session_id, project, prompt, timestamp_ms) VALUES (?, ?, ?, ?, ?)',
);
// The unique key is (source, timestamp_ms, prompt), so the other scope needs its own timestamp.
insert.run('claude', 'run-1', scope, 'retry safely', 1000);
insert.run('claude', 'run-2', `${scope}-other`, 'retry safely', 1001);
db.close();
