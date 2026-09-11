// node testdata/memory/seed.mjs <db-path> <script-scope>
// Uses the same SQLite implementation shipped by ai-hist; no cloud or host history.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../packages/sdk/package.json', import.meta.url));
const aiHistRequire = createRequire(require.resolve('ai-hist/package.json'));
const SQL = await aiHistRequire('sql.js')();
const db = new SQL.Database();
const [path, scope] = process.argv.slice(2);
if (!path || !scope) throw new Error('expected database path and script scope');
db.run(`CREATE TABLE history (
 id INTEGER PRIMARY KEY, source TEXT, session_id TEXT, project TEXT,
 prompt TEXT, timestamp_ms INTEGER, git_branch TEXT
);
CREATE TABLE trajectories (
 id TEXT PRIMARY KEY, version INTEGER, persona_id TEXT, project_id TEXT,
 task_title TEXT, task_description TEXT, status TEXT, started_at TEXT,
 completed_at TEXT, decisions_json TEXT, retrospective_json TEXT,
 search_text TEXT, path TEXT, updated_ms INTEGER, timestamp_ms INTEGER
);`);
for (const [id, project] of [[1, scope], [2, `${scope}-other`]]) {
 db.run('INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?)',
  [id, 'trajectory', `run-${id}`, project, 'retry safely', 1000, null]);
 db.run('INSERT INTO trajectories VALUES (?, 1, NULL, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, 1000, 1000)',
  [`run-${id}`, project, 'retry safely', 'completed', JSON.stringify([
    {question:'retry safely', chosen:'idempotency key', reasoning:'avoid duplicate writes', alternatives:[]}
  ]), '{}', 'retry safely']);
}
writeFileSync(path, Buffer.from(db.export()));
db.close();
