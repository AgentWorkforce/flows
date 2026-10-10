import type { MemoryHelper } from '@relayflows/surface';
import type { MemoryFinding } from '@relayflows/surface';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { preflightMemory } from './preflight.js';

/** Stable across runs; disjoint from other flow files and other named flows. */
export function scriptMemoryScope(flowPath: string, name: string): string {
  const absolute = resolve(flowPath);
  const key = createHash('sha256').update(JSON.stringify([absolute, name])).digest('hex');
  return join(dirname(absolute), '.relayflows', 'memory', 'scripts', key);
}

export async function probeScriptMemory(): Promise<void> {
  const { defaultDbPath, openAiHist } = await import('ai-hist');
  const path = defaultDbPath();
  await access(path, constants.R_OK);
  if (!(await stat(path)).isFile()) throw new Error('memory database must be a file');
  const reader = await openAiHist({ dbPath: path, fallback: 'error' });
  try { reader.search('', { limit: 1 }); } finally { reader.close(); }
}

export async function assertMemoryReachable(): Promise<void> {
  const refusal = await preflightMemory(probeScriptMemory);
  if (refusal) throw new AuthoredFlowExecutionError('memory_unreachable', refusal.message);
}

export function authoredMemory(
  scope: string,
  assertOpen: () => void,
  enabled: boolean,
): MemoryHelper {
  async function read<T>(action: (reader: import('ai-hist').AiHist) => T): Promise<T> {
    assertOpen();
    if (!enabled) throw new AuthoredFlowExecutionError('unsupported_header', 'f.memory requires script memory; memory.script is false');
    await assertMemoryReachable();
    assertOpen();
    const { openAiHist } = await import('ai-hist');
    const reader = await openAiHist({ projectScope: scope, fallback: 'error' });
    try { return action(reader); } finally { reader.close(); }
  }
  return {
    recall: (query, options) => read(reader => reader.search(query, { ...options, project: scope })),
    why: task => read(reader => {
      const entry = reader.whyForTask(task);
      return entry?.projectId === scope ? [entry] : [];
    }),
    async learn(finding) {
      assertOpen();
      if (!enabled) throw new AuthoredFlowExecutionError('unsupported_header', 'f.memory requires script memory; memory.script is false');
      const decision = normalizeFinding(finding);
      await assertMemoryReachable();
      assertOpen();
      const { defaultDbPath } = await import('ai-hist');
      try {
        await persistFinding(defaultDbPath(), scope, decision);
      } catch (error) {
        throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn could not persist the finding: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

interface SqlDatabase {
  run(sql: string, params?: unknown[]): void;
  export(): Uint8Array;
  close(): void;
}
type SqlJs = { Database: new (data?: Uint8Array) => SqlDatabase };

/** sql.js is the SQLite build ai-hist ships; resolve it through ai-hist so the two always agree. */
async function loadSqlJs(): Promise<SqlJs> {
  const fromAiHist = createRequire(createRequire(import.meta.url).resolve('ai-hist/package.json'));
  const init = fromAiHist('sql.js') as (config?: unknown) => Promise<SqlJs>;
  return init();
}

function normalizeFinding(finding: MemoryFinding): Required<MemoryFinding> {
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AuthoredFlowExecutionError('memory_finding_invalid', `f.memory.learn requires a non-empty string ${field}`);
    }
    return value;
  };
  const alternatives = finding?.alternatives ?? [];
  if (!Array.isArray(alternatives) || alternatives.some(item => typeof item !== 'string')) {
    throw new AuthoredFlowExecutionError('memory_finding_invalid', 'f.memory.learn alternatives must be an array of strings');
  }
  return {
    question: text(finding?.question, 'question'),
    chosen: text(finding?.chosen, 'chosen'),
    reasoning: text(finding?.reasoning, 'reasoning'),
    alternatives: [...alternatives],
  };
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/**
 * Persist one finding so later runs of the same flow can recall it.
 *
 * Two idempotent writes, both scoped to the flow's script scope:
 * - a compacted trajectory file under `<scope>/.trajectories/compacted/`, the
 *   format ai-hist ingests, so a later `ai-hist sync` re-indexes it;
 * - the matching `trajectories` and `history` rows in the ai-hist database,
 *   mirroring ai-hist's own ingestion, so the next run sees it without a sync.
 */
async function persistFinding(dbPath: string, scope: string, decision: Required<MemoryFinding>): Promise<void> {
  const now = new Date();
  const timestampMs = now.getTime();
  // Content-addressed: re-learning the same finding (a resumed body re-running
  // its effects, or a later run reaching the same conclusion) upserts one record.
  const id = `flows-memory-${createHash('sha256').update(JSON.stringify([scope, decision])).digest('hex').slice(0, 32)}`;
  const retrospective = { summary: null, approach: null, learnings: [] as string[], confidence: null };
  const trajectory = {
    id,
    version: 1,
    type: 'compacted',
    projectId: scope,
    task: { title: decision.question, description: null },
    status: 'completed',
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    decisions: [decision],
    retrospective,
  };
  const file = join(scope, '.trajectories', 'compacted', `${id}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeAtomic(file, `${JSON.stringify(trajectory, null, 2)}\n`);

  // Same field order ai-hist's buildSearchText uses, so search ranks identically after a sync.
  const searchText = [
    id, scope, trajectory.status, decision.question,
    decision.question, decision.chosen, decision.reasoning, ...decision.alternatives,
  ].filter(part => part.length > 0).join('\n');
  const SQL = await loadSqlJs();
  const db = new SQL.Database(await readFile(dbPath));
  try {
    db.run(`CREATE TABLE IF NOT EXISTS trajectories (
      id TEXT PRIMARY KEY, version INTEGER, persona_id TEXT, project_id TEXT,
      task_title TEXT, task_description TEXT, status TEXT, started_at TEXT,
      completed_at TEXT, decisions_json TEXT NOT NULL, retrospective_json TEXT NOT NULL,
      search_text TEXT NOT NULL, path TEXT, updated_ms INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL
    )`);
    db.run(`INSERT OR REPLACE INTO trajectories
      (id, version, persona_id, project_id, task_title, task_description, status,
       started_at, completed_at, decisions_json, retrospective_json, search_text,
       path, updated_ms, timestamp_ms)
      VALUES (?, 1, NULL, ?, ?, NULL, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, scope, decision.question, trajectory.startedAt, trajectory.completedAt,
      JSON.stringify([decision]), JSON.stringify(retrospective), searchText, file, timestampMs, timestampMs,
    ]);
    db.run(`DELETE FROM history WHERE source = 'trajectory' AND session_id = ?`, [id]);
    db.run(`INSERT OR IGNORE INTO history (source, session_id, project, prompt, timestamp_ms, git_branch)
      VALUES ('trajectory', ?, ?, ?, ?, NULL)`, [id, scope, searchText, timestampMs]);
    await writeAtomic(dbPath, db.export());
  } finally {
    db.close();
  }
}
