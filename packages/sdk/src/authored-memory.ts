import type { HistoryEntry, MemoryFinding, MemoryHelper, MemoryRecallOptions, TrajectoryEntry } from '@relayflows/surface';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
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

/** Lets the executor see `learn` calls the body has not awaited. */
export interface MemoryWriteTracker {
  readonly pending: Set<Promise<void>>;
}

export function authoredMemory(
  scope: string,
  assertOpen: () => void,
  enabled: boolean,
  tracker?: MemoryWriteTracker,
): MemoryHelper {
  function assertEnabled(): void {
    if (!enabled) throw new AuthoredFlowExecutionError('unsupported_header', 'f.memory requires script memory; memory.script is false');
  }
  async function read<T>(action: (reader: import('ai-hist').AiHist, learned: LearnedTrajectory[]) => T): Promise<T> {
    assertOpen();
    assertEnabled();
    await assertMemoryReachable();
    assertOpen();
    const learned = await readLearned(scope);
    const { openAiHist } = await import('ai-hist');
    const reader = await openAiHist({ projectScope: scope, fallback: 'error' });
    try { return action(reader, learned); } finally { reader.close(); }
  }
  async function learn(finding: MemoryFinding): Promise<void> {
    assertOpen();
    assertEnabled();
    const decision = normalizeFinding(finding);
    await assertMemoryReachable();
    assertOpen();
    const { defaultDbPath } = await import('ai-hist');
    try {
      await writeLearned(scope, decision, (await stat(defaultDbPath())).mode & 0o777);
    } catch (error) {
      throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn could not persist the finding: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    recall: (query, options) => read((reader, learned) => recallMerged(reader, learned, scope, query, options)),
    why: task => read((reader, learned) => {
      const synced = reader.whyForTask(task);
      const candidates = [
        ...(synced?.projectId === scope ? [synced] : []),
        ...learned.map(entry => entry.trajectory).filter(entry => trajectoryMatches(entry, task)),
      ];
      const newest = candidates.sort((a, b) => b.timestampMs - a.timestampMs)[0];
      return newest === undefined ? [] : [newest];
    }),
    learn(finding) {
      const write = learn(finding);
      if (tracker !== undefined) {
        tracker.pending.add(write);
        void write.then(() => tracker.pending.delete(write), () => tracker.pending.delete(write));
      }
      return write;
    },
  };
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

const learnedDir = (scope: string): string => join(scope, '.trajectories', 'compacted');
const LEARNED_PREFIX = 'flows-memory-';

/**
 * Persist one finding as an immutable compacted trajectory file, the format
 * `ai-hist sync` ingests. The file name is a hash of scope and finding, so
 * re-learning the same finding (a resumed body re-running `learn`, or a later
 * run reaching the same conclusion) rewrites one file rather than adding one.
 * The file is staged and renamed into place, so it appears whole or not at
 * all, and nothing else is shared between writers: no lock, and the ai-hist
 * database is never modified. It takes the database's mode, so a private
 * history does not leak findings through a world-readable file.
 */
async function writeLearned(scope: string, decision: Required<MemoryFinding>, mode: number): Promise<void> {
  const now = new Date().toISOString();
  const id = `${LEARNED_PREFIX}${createHash('sha256').update(JSON.stringify([scope, decision])).digest('hex').slice(0, 32)}`;
  const trajectory = {
    id,
    version: 1,
    type: 'compacted',
    projectId: scope,
    task: { title: decision.question, description: null },
    status: 'completed',
    startedAt: now,
    completedAt: now,
    decisions: [decision],
    retrospective: { summary: null, approach: null, learnings: [], confidence: null },
  };
  const file = join(learnedDir(scope), `${id}.json`);
  await mkdir(dirname(file), { recursive: true });
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, `${JSON.stringify(trajectory, null, 2)}\n`, { mode });
    await chmod(staged, mode);
    await rename(staged, file);
  } finally {
    await rm(staged, { force: true });
  }
}

interface LearnedTrajectory {
  trajectory: TrajectoryEntry;
  history: HistoryEntry;
}

/** This scope's learned findings, read straight from disk so they need no `ai-hist sync`. */
async function readLearned(scope: string): Promise<LearnedTrajectory[]> {
  const dir = learnedDir(scope);
  let names: string[];
  try { names = await readdir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const learned: LearnedTrajectory[] = [];
  for (const name of names) {
    if (!name.startsWith(LEARNED_PREFIX) || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; } catch { continue; }
    const decisions = Array.isArray(raw.decisions) ? raw.decisions as TrajectoryEntry['decisions'] : [];
    const task = (raw.task ?? {}) as { title?: string | null; description?: string | null };
    const id = typeof raw.id === 'string' ? raw.id : name.slice(0, -'.json'.length);
    const completedAt = typeof raw.completedAt === 'string' ? raw.completedAt : null;
    const updatedMs = Math.trunc((await stat(path)).mtimeMs);
    const timestampMs = completedAt !== null && Number.isFinite(Date.parse(completedAt)) ? Date.parse(completedAt) : updatedMs;
    // Same field order ai-hist's buildSearchText uses, so matching agrees with a later sync.
    const searchText = [id, scope, 'completed', task.title ?? null, task.description ?? null,
      ...decisions.flatMap(d => [d.question, d.chosen, d.reasoning, ...(d.alternatives ?? [])])]
      .filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
    learned.push({
      trajectory: {
        id, version: 1, personaId: null, projectId: scope,
        task: { title: task.title ?? null, description: task.description ?? null },
        status: 'completed', startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null, completedAt,
        decisions, retrospective: { summary: null, approach: null, learnings: [], confidence: null },
        searchText, path, updatedMs, timestampMs,
      },
      // Not yet in the ai-hist database, so it has no row id; a negative id
      // derived from the trajectory id marks it as read from disk.
      history: {
        id: -Number.parseInt(createHash('sha256').update(id).digest('hex').slice(0, 12), 16),
        source: 'trajectory', sessionId: id, project: scope, prompt: searchText, timestampMs, gitBranch: null,
      },
    });
  }
  return learned;
}

const includesFolded = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? '').toLowerCase().includes(needle.toLowerCase());

function trajectoryMatches(entry: TrajectoryEntry, query: string): boolean {
  const needle = query.trim();
  if (needle === '') return false;
  return [entry.searchText, entry.task.title, entry.task.description, entry.personaId, entry.projectId]
    .some(field => includesFolded(field, needle));
}

/** ai-hist's `search` semantics over the database plus this scope's not-yet-synced findings. */
function recallMerged(
  reader: import('ai-hist').AiHist,
  learned: LearnedTrajectory[],
  scope: string,
  query: string,
  options: MemoryRecallOptions | undefined,
): HistoryEntry[] {
  const limit = options?.limit ?? 50;
  const needle = query.trim();
  const fromDisk = learned.map(entry => entry.history).filter(entry =>
    (needle === '' || includesFolded(entry.prompt, needle) || includesFolded(entry.project, needle))
    && (options?.source === undefined || options.source === 'trajectory')
    && options?.tag === undefined
    && (options?.beforeMs === undefined || entry.timestampMs < options.beforeMs));
  // Fetching `limit + fromDisk.length` rows guarantees a synced copy of any
  // disk entry that makes the cut is among them, so it dedupes correctly.
  const synced = reader.search(query, { ...options, project: scope, limit: limit + fromDisk.length });
  const syncedIds = new Set(synced.filter(entry => entry.source === 'trajectory').map(entry => entry.sessionId));
  return [...synced, ...fromDisk.filter(entry => !syncedIds.has(entry.sessionId))]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, limit);
}
