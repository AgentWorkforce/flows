import type { HistoryEntry, MemoryFinding, MemoryHelper, MemoryRecallOptions, TrajectoryEntry } from '@relayflows/surface';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
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

/**
 * The promise `learn` returns. Its constructor is not `Promise`, so `await`,
 * `Promise.all` and friends reach it through `then`, which records that the
 * body consumed the result.
 */
class LearnCall extends Promise<void> {
  static override get [Symbol.species](): PromiseConstructor { return Promise; }
  observed = false;
  settled = false;
  override then<A = void, B = never>(
    onFulfilled?: ((value: void) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.observed = true;
    return super.then(onFulfilled, onRejected);
  }
}

/** Lets the executor find `learn` calls whose outcome the body never consumed. */
export class MemoryWriteTracker {
  private readonly calls: LearnCall[] = [];
  track(write: Promise<void>): Promise<void> {
    const call = new LearnCall((resolve, reject) => { void write.then(resolve, reject); });
    // Bypass the override: marking the rejection handled must not count as the body consuming it.
    void Promise.prototype.then.call(call, () => { call.settled = true; }, () => { call.settled = true; });
    this.calls.push(call);
    return call;
  }
  /** Every call the body did not await, after letting each one settle. */
  async unawaited(): Promise<number> {
    const unobserved = this.calls.filter(call => !call.observed || !call.settled);
    await Promise.allSettled(unobserved.map(call => Promise.prototype.then.call(call, () => {}, () => {})));
    return unobserved.length;
  }
}

/** Root-run stream holding every finding `learn` committed: the source of truth the trajectory files are projected from. */
export const MEMORY_LEARN_STREAM = 'memory-learn';

export interface LearnRecord {
  readonly memory: 'learn';
  readonly id: string;
  readonly scope: string;
  readonly decision: Required<MemoryFinding>;
  readonly learnedAt: string;
}

export interface CommittedLearn {
  readonly record: LearnRecord;
  readonly runId: string;
  readonly offset: number;
}

/** Where `learn` journals a finding before it may become recallable. */
export interface LearnLedger {
  /** The recorded commit for `id`, or a new one journaled from `build()`. Concurrent calls for one id share one commit. */
  commit(id: string, build: () => LearnRecord): Promise<CommittedLearn>;
}

function canonicalLearnRecord(raw: unknown): LearnRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const decision = value.decision as Record<string, unknown> | undefined;
  if (value.memory !== 'learn' || typeof value.id !== 'string' || typeof value.scope !== 'string'
    || typeof value.learnedAt !== 'string' || typeof decision !== 'object' || decision === null) return undefined;
  const { question, chosen, reasoning, alternatives } = decision;
  if (typeof question !== 'string' || typeof chosen !== 'string' || typeof reasoning !== 'string'
    || !Array.isArray(alternatives) || alternatives.some(item => typeof item !== 'string')) return undefined;
  // Fixed field order, never the record as it came back: the journal stores
  // stream messages with sorted keys, and the projected file must be
  // byte-identical whether it is written now or republished on resume.
  return {
    memory: 'learn', id: value.id, scope: value.scope,
    decision: { question, chosen, reasoning, alternatives: [...alternatives] as string[] },
    learnedAt: value.learnedAt,
  };
}

/**
 * A ledger on the durable root run's `memory-learn` stream. The stream is read
 * once per execution, so a resumed body finds what an earlier attempt already
 * committed and does not journal it twice.
 */
export function journalLearnLedger(journal: Pick<JournalClient, 'streamAppend' | 'streamRead'>, rootRunId: string): LearnLedger {
  let loaded: Promise<Map<string, CommittedLearn>> | undefined;
  const inFlight = new Map<string, Promise<CommittedLearn>>();
  async function load(): Promise<Map<string, CommittedLearn>> {
    const commits = new Map<string, CommittedLearn>();
    let offset = 0;
    for (;;) {
      const page = await journal.streamRead(rootRunId, MEMORY_LEARN_STREAM, offset, 1000);
      page.messages.forEach((message, index) => {
        const record = canonicalLearnRecord((message as { message?: unknown }).message ?? message);
        // The first commit for an id wins; it is the one its file cites.
        if (record !== undefined && !commits.has(record.id)) commits.set(record.id, { record, runId: rootRunId, offset: offset + index });
      });
      if (page.messages.length === 0 || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
    return commits;
  }
  return {
    commit(id, build) {
      const pending = inFlight.get(id);
      if (pending !== undefined) return pending;
      const committing = (async () => {
        loaded ??= load();
        const commits = await loaded;
        const existing = commits.get(id);
        if (existing !== undefined) return existing;
        const record = build();
        const { offset } = await journal.streamAppend(rootRunId, MEMORY_LEARN_STREAM, record);
        const committed = { record, runId: rootRunId, offset };
        commits.set(id, committed);
        return committed;
      })();
      inFlight.set(id, committing);
      void committing.then(() => inFlight.delete(id), () => inFlight.delete(id));
      return committing;
    },
  };
}

export function authoredMemory(
  scope: string,
  assertOpen: () => void,
  enabled: boolean,
  tracker?: MemoryWriteTracker,
  ledger?: LearnLedger,
): MemoryHelper {
  function assertEnabled(): void {
    if (!enabled) throw new AuthoredFlowExecutionError('unsupported_header', 'f.memory requires script memory; memory.script is false');
  }
  async function read<T>(action: (reader: import('ai-hist').AiHist, learned: LearnedTrajectory[]) => T): Promise<T> {
    assertOpen();
    assertEnabled();
    await assertMemoryReachable();
    assertOpen();
    const { defaultDbPath, openAiHist } = await import('ai-hist');
    const learned = await readLearned(defaultDbPath(), scope);
    const reader = await openAiHist({ projectScope: scope, fallback: 'error' });
    try { return action(reader, learned); } finally { reader.close(); }
  }
  /**
   * Journal first, then project. The finding is committed to the root run's
   * `memory-learn` stream before its trajectory file exists, so nothing is
   * recallable that the journal does not record. A crash between the two
   * leaves a journaled finding without its file; the resumed body re-runs
   * `learn`, finds the commit, and republishes the identical file from it
   * without journaling again. With no durable root run there is nowhere to
   * journal, so `learn` refuses rather than write unrecorded memory.
   */
  async function learn(finding: MemoryFinding): Promise<void> {
    assertOpen();
    assertEnabled();
    const decision = normalizeFinding(finding);
    if (ledger === undefined) {
      throw new AuthoredFlowExecutionError('memory_unjournaled', 'f.memory.learn requires a durable root run to journal the finding; run the flow through flows run');
    }
    await assertMemoryReachable();
    assertOpen();
    const id = learnedId(scope, decision);
    let committed: CommittedLearn;
    try {
      committed = await ledger.commit(id, () => ({ memory: 'learn', id, scope, decision, learnedAt: new Date().toISOString() }));
    } catch (error) {
      throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn could not journal the finding: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { defaultDbPath } = await import('ai-hist');
    const dbPath = defaultDbPath();
    try {
      await writeLearned(dbPath, committed, (await stat(dbPath)).mode & 0o777);
    } catch (error) {
      throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn journaled the finding but could not publish it: ${error instanceof Error ? error.message : String(error)}`);
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
      return tracker === undefined ? write : tracker.track(write);
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

/**
 * Learned findings live beside the ai-hist database, not beside the flow
 * source: a flow deployed from a read-only checkout, package or image can
 * still learn. The directory is keyed by the scope's hash, and each file
 * still names the scope as its `projectId`. `ai-hist sync` indexes them when
 * `TRAJECTORY_ROOT` includes `<db-dir>/flows-memory`; reads here do not need it.
 */
const learnedDir = (dbPath: string, scope: string): string =>
  join(dirname(dbPath), 'flows-memory', basename(scope), '.trajectories', 'compacted');
const LEARNED_PREFIX = 'flows-memory-';

const learnedId = (scope: string, decision: Required<MemoryFinding>): string =>
  `${LEARNED_PREFIX}${createHash('sha256').update(JSON.stringify([scope, decision])).digest('hex').slice(0, 32)}`;

/**
 * Project one committed finding as an immutable compacted trajectory file, the
 * format `ai-hist sync` ingests. Its content is derived only from the journal
 * commit (including the time it was learned and a citation of the commit), so
 * republishing on resume writes the same bytes. The file name is a hash of
 * scope and finding, so re-learning the same finding rewrites one file. It is
 * staged and renamed into place, so it appears whole or not at all, and the
 * ai-hist database is never modified. It takes the database's mode, so a
 * private history does not leak findings through a world-readable file.
 */
async function writeLearned(dbPath: string, { record, runId, offset }: CommittedLearn, mode: number): Promise<void> {
  const trajectory = {
    id: record.id,
    version: 1,
    type: 'compacted',
    projectId: record.scope,
    task: { title: record.decision.question, description: null },
    status: 'completed',
    startedAt: record.learnedAt,
    completedAt: record.learnedAt,
    decisions: [record.decision],
    retrospective: { summary: null, approach: null, learnings: [], confidence: null },
    journal: { runId, stream: MEMORY_LEARN_STREAM, offset },
  };
  const file = join(learnedDir(dbPath, record.scope), `${record.id}.json`);
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
async function readLearned(dbPath: string, scope: string): Promise<LearnedTrajectory[]> {
  const dir = learnedDir(dbPath, scope);
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
    try {
      raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Files here are only ever published whole, so an unreadable one is real
      // damage; recalling around it would silently drop journaled memory.
      throw new AuthoredFlowExecutionError('memory_unreachable', `learned finding ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
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
