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
  /** Wait for every call to settle, so no write outlives the execution that started it. */
  async settle(): Promise<void> {
    await Promise.allSettled(this.calls.map(call => Promise.prototype.then.call(call, () => {}, () => {})));
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
}

/** Where `learn` journals a finding before it may become recallable. */
export interface LearnLedger {
  /** The durable root run this ledger journals on. */
  readonly runId: string;
  /** The commit already recorded for `id`, if any. */
  recorded(id: string): Promise<CommittedLearn | undefined>;
  /**
   * Journal `record`, then return the commit that wins for its id: the first
   * one in the stream. Usually that is `record`; if another attempt on this
   * root committed the same finding first, it is theirs, so every attempt
   * projects the same bytes.
   */
  append(record: LearnRecord): Promise<CommittedLearn>;
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
 * once per execution and re-read after each append, so a resumed or re-driven
 * body finds what any earlier attempt committed. A failed read is not cached:
 * the next call reads again. Journal errors propagate unchanged, so a read
 * interruption or a lost lease keeps its resumable meaning for the root.
 */
export function journalLearnLedger(journal: Pick<JournalClient, 'streamAppend' | 'streamRead'>, rootRunId: string): LearnLedger {
  let loaded: Promise<Map<string, CommittedLearn>> | undefined;
  async function read(): Promise<Map<string, CommittedLearn>> {
    const commits = new Map<string, CommittedLearn>();
    let offset = 0;
    for (;;) {
      const page = await journal.streamRead(rootRunId, MEMORY_LEARN_STREAM, offset, 1000);
      for (const message of page.messages) {
        const record = canonicalLearnRecord((message as { message?: unknown }).message ?? message);
        // The first commit for an id wins; it is the one its file is built from.
        if (record !== undefined && !commits.has(record.id)) commits.set(record.id, { record, runId: rootRunId });
      }
      if (page.messages.length === 0 || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
    return commits;
  }
  function load(): Promise<Map<string, CommittedLearn>> {
    loaded ??= read().catch(error => { loaded = undefined; throw error; });
    return loaded;
  }
  return {
    runId: rootRunId,
    async recorded(id) {
      return (await load()).get(id);
    },
    async append(record) {
      await journal.streamAppend(rootRunId, MEMORY_LEARN_STREAM, record);
      loaded = undefined;
      return (await load()).get(record.id) ?? { record, runId: rootRunId };
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
   * Journal first, then publish. The trajectory file is staged under a name
   * no read lists, the finding is committed to the root run's `memory-learn`
   * stream, and only then is the file renamed into place. Nothing is
   * recallable that the journal does not record, and the failures a disk
   * write can have (space, permissions) happen while staging, before anything
   * is journaled. If the process dies between the commit and the rename, the
   * resumed body re-runs `learn`, finds the commit, and publishes the same
   * file from it without journaling again. With no durable root run there is
   * nowhere to journal, so `learn` refuses rather than write unrecorded memory.
   */
  const learning = new Map<string, Promise<void>>();
  async function learnOnce(decision: Required<MemoryFinding>, journaled: LearnLedger): Promise<void> {
    const { dbPath, mode } = await learnTarget();
    const id = learnedId(scope, decision);
    const existing = await journaled.recorded(id);
    if (existing !== undefined) {
      await publishLearned(dbPath, existing, mode);
      return;
    }
    const record: LearnRecord = { memory: 'learn', id, scope, decision, learnedAt: new Date().toISOString() };
    let staged: StagedLearned;
    try {
      staged = await stageLearned(dbPath, { record, runId: journaled.runId }, mode);
    } catch (error) {
      throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn could not stage the finding: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // The last point a body that already called done() can be refused: past
      // here the finding is journaled and will be published.
      assertOpen();
      const winner = await journaled.append(record);
      try {
        await staged.publish(winner);
      } catch (error) {
        throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn journaled the finding (root run ${winner.runId}, stream ${MEMORY_LEARN_STREAM}, id ${id}) but could not publish it: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      await staged.discard();
    }
  }
  async function learn(finding: MemoryFinding): Promise<void> {
    assertOpen();
    assertEnabled();
    const decision = normalizeFinding(finding);
    if (ledger === undefined) {
      throw new AuthoredFlowExecutionError('memory_unjournaled', 'f.memory.learn requires a durable root run to journal the finding; run the flow through flows run');
    }
    const id = learnedId(scope, decision);
    // Concurrent learns of one finding in this execution share one commit.
    let pending = learning.get(id);
    if (pending === undefined) {
      pending = learnOnce(decision, ledger);
      learning.set(id, pending);
      void pending.then(() => learning.delete(id), () => learning.delete(id));
    }
    await pending;
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
 * still names the scope as its `projectId`. Reads here do not need
 * `ai-hist sync`. For sync to index them too, add `<db-dir>/flows-memory` to
 * `TRAJECTORY_ROOT` together with the roots it already scans: setting it
 * replaces ai-hist's default `~/Projects` scan rather than adding to it.
 */
const learnedDir = (dbPath: string, scope: string): string =>
  join(dirname(dbPath), 'flows-memory', basename(scope), '.trajectories', 'compacted');
const LEARNED_PREFIX = 'flows-memory-';

const learnedId = (scope: string, decision: Required<MemoryFinding>): string =>
  `${LEARNED_PREFIX}${createHash('sha256').update(JSON.stringify([scope, decision])).digest('hex').slice(0, 32)}`;

/**
 * `learn` never reads the ai-hist database, so it does not load it: it needs
 * only the directory it lives in and its mode. A missing database is the same
 * refusal reads give.
 */
async function learnTarget(): Promise<{ dbPath: string; mode: number }> {
  const { defaultDbPath } = await import('ai-hist');
  const dbPath = defaultDbPath();
  const info = await stat(dbPath).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new AuthoredFlowExecutionError('memory_unreachable', `memory database ${dbPath} is missing or not a file`);
  }
  return { dbPath, mode: info.mode & 0o777 };
}

function learnedContent({ record, runId }: CommittedLearn): string {
  return `${JSON.stringify({
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
    journal: { runId, stream: MEMORY_LEARN_STREAM, id: record.id },
  }, null, 2)}\n`;
}

interface StagedLearned {
  /** Rename into place, rewriting first if the winning commit is not the one staged. */
  publish(winner: CommittedLearn): Promise<void>;
  discard(): Promise<void>;
}

/**
 * Write a committed finding's compacted trajectory file under a temporary
 * name. Its content is derived only from the commit (including when it was
 * learned and which root run journaled it), so every publication of one
 * commit writes the same bytes. The final name is a hash of scope and
 * finding, so re-learning a finding atomically replaces one file. The file
 * takes the database's mode, so a private history does not leak findings
 * through a world-readable file. The ai-hist database is never modified.
 */
async function stageLearned(dbPath: string, staging: CommittedLearn, mode: number): Promise<StagedLearned> {
  const file = join(learnedDir(dbPath, staging.record.scope), `${staging.record.id}.json`);
  await mkdir(dirname(file), { recursive: true });
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let content = learnedContent(staging);
  const write = async () => {
    await writeFile(staged, content, { mode });
    await chmod(staged, mode);
  };
  try {
    await write();
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
  return {
    async publish(winner) {
      const winning = learnedContent(winner);
      if (winning !== content) {
        content = winning;
        await write();
      }
      await rename(staged, file);
    },
    discard: () => rm(staged, { force: true }),
  };
}

async function publishLearned(dbPath: string, committed: CommittedLearn, mode: number): Promise<void> {
  let staged: StagedLearned;
  try {
    staged = await stageLearned(dbPath, committed, mode);
  } catch (error) {
    throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn could not publish journaled finding ${committed.record.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await staged.publish(committed);
  } catch (error) {
    throw new AuthoredFlowExecutionError('memory_unwritable', `f.memory.learn could not publish journaled finding ${committed.record.id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await staged.discard();
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
  const learned = await Promise.all(names
    .filter(name => name.startsWith(LEARNED_PREFIX) && name.endsWith('.json'))
    .map(async name => {
      const path = join(dir, name);
      try {
        return learnedEntry(scope, path, await readFile(path, 'utf8'), Math.trunc((await stat(path)).mtimeMs));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        // Files here are only ever published whole, so an unreadable one is
        // real damage; recalling around it would silently drop journaled memory.
        throw new AuthoredFlowExecutionError('memory_unreachable', `learned finding ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  return learned.filter((entry): entry is LearnedTrajectory => entry !== undefined);
}

function learnedEntry(scope: string, path: string, text: string, updatedMs: number): LearnedTrajectory {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not a trajectory object');
  const value = raw as Record<string, unknown>;
  const decisions = value.decisions;
  if (typeof value.id !== 'string' || !Array.isArray(decisions)) throw new Error('missing id or decisions');
  const parsed = decisions.map(decision => {
    const d = decision as Record<string, unknown> | null;
    if (typeof d !== 'object' || d === null || typeof d.question !== 'string' || typeof d.chosen !== 'string'
      || typeof d.reasoning !== 'string' || !Array.isArray(d.alternatives) || d.alternatives.some(a => typeof a !== 'string')) {
      throw new Error('malformed decision');
    }
    return { question: d.question, chosen: d.chosen, reasoning: d.reasoning, alternatives: d.alternatives as string[] };
  });
  const task = (typeof value.task === 'object' && value.task !== null ? value.task : {}) as Record<string, unknown>;
  const title = typeof task.title === 'string' ? task.title : null;
  const description = typeof task.description === 'string' ? task.description : null;
  const id = value.id;
  const completedAt = typeof value.completedAt === 'string' ? value.completedAt : null;
  const timestampMs = completedAt !== null && Number.isFinite(Date.parse(completedAt)) ? Date.parse(completedAt) : updatedMs;
  // Same field order ai-hist's buildSearchText uses, so matching agrees with a later sync.
  const searchText = [id, scope, 'completed', title, description,
    ...parsed.flatMap(d => [d.question, d.chosen, d.reasoning, ...d.alternatives])]
    .filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
  return {
    trajectory: {
      id, version: 1, personaId: null, projectId: scope,
      task: { title, description },
      status: 'completed', startedAt: typeof value.startedAt === 'string' ? value.startedAt : null, completedAt,
      decisions: parsed, retrospective: { summary: null, approach: null, learnings: [], confidence: null },
      searchText, path, updatedMs, timestampMs,
    },
    // Not yet in the ai-hist database, so it has no row id; a negative id
    // derived from the trajectory id marks it as read from disk.
    history: {
      id: -Number.parseInt(createHash('sha256').update(id).digest('hex').slice(0, 12), 16),
      source: 'trajectory', sessionId: id, project: scope, prompt: searchText, timestampMs, gitBranch: null,
    },
  };
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
