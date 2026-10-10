import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flow } from '@relayflows/surface';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let failRename: ((to: string) => boolean) | undefined;
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failRename?.(to)) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return actual.rename(from, to);
    },
  };
});
import { openAiHist } from 'ai-hist';
import { authoredMemory, journalLearnLedger, MEMORY_LEARN_STREAM, scriptMemoryScope } from '../src/authored-memory.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { AuthoredFlowExecutionError } from '../src/authored-flow-error.js';
import { emptyReport, memoryWriteFailure } from '../src/cli/run.js';
import { JournalClient } from '../src/journal-client.js';
import { preflightMemory } from '../src/preflight.js';

let dir: string;
let scope: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flows-memory-'));
  dbPath = join(dir, 'fixture.db');
  scope = scriptMemoryScope(join(dir, 'test.flow.ts'), 'memory-example');
  execFileSync(process.execPath, [fileURLToPath(new URL('../../../testdata/memory/seed.mjs', import.meta.url)), dbPath, scope]);
  vi.stubEnv('AI_HIST_DB', dbPath);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

/** The daemon's stream storage, with the kernel's paging contract (`engine/remote.rs` `read_stream`). */
function streamStore() {
  const stored = new Map<string, unknown[]>();
  const key = (runId: string, stream: string): string => `${runId}\u0000${stream}`;
  const appended: Array<{ stream: string; message: unknown; fileExisted: boolean }> = [];
  return {
    stored, appended,
    list: (runId: string, stream: string) => stored.get(key(runId, stream)) ?? [],
    async streamAppend(runId: string, stream: string, message: unknown) {
      const list = stored.get(key(runId, stream)) ?? [];
      stored.set(key(runId, stream), list);
      appended.push({ stream, message, fileExisted: existsSync(compactedDir()) && readdirSync(compactedDir()).length > 0 });
      // Stored the way the journal stores it: keys sorted.
      list.push(JSON.parse(JSON.stringify(message, Object.keys(flatKeys(message)).sort())));
      return { offset: list.length - 1 };
    },
    async streamRead(runId: string, stream: string, fromOffset: number, limit: number) {
      const messages = (stored.get(key(runId, stream)) ?? []).slice(fromOffset, fromOffset + limit);
      return { messages, next_offset: fromOffset + messages.length };
    },
  };
}
function flatKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) { keys[k] = true; flatKeys(v, keys); }
  }
  return keys;
}
let store: ReturnType<typeof streamStore>;
beforeEach(() => { store = streamStore(); });
const memoryFor = (forScope: string) => authoredMemory(forScope, () => {}, true, undefined, journalLearnLedger(store, 'root-1'));
const compactedDir = (forScope = scope) => join(dir, 'flows-memory', basename(forScope), '.trajectories', 'compacted');

it('reads the seeded local SQLite database with cloud unused and fallback disabled', async () => {
  const db = await openAiHist({ dbPath, projectScope: scope, fallback: 'error' });
  try { expect(db.search('retry safely')).toHaveLength(1); } finally { db.close(); }
  const memory = memoryFor(scope);
  expect(await memory.recall('retry safely')).toMatchObject([{ id: 1, project: scope }]);
  expect(await memory.why('retry safely')).toMatchObject([{
    id: 'run-1', decisions: [{ chosen: 'idempotency key', reasoning: 'avoid duplicate writes' }],
  }]);
  expect(await memory.recall('no match')).toEqual([]);
  expect(await memory.why('no match')).toEqual([]);
});

it('cannot widen script scope using a raw project option or another flow name', async () => {
  const memory = memoryFor(scope);
  expect(await memory.recall('', { project: `${scope}-other` } as never)).toMatchObject([{ id: 1 }]);
  const other = memoryFor(scriptMemoryScope(join(dir, 'test.flow.ts'), 'another-flow'));
  expect(await other.recall('retry safely')).toEqual([]);
  expect(await other.why('retry safely')).toEqual([]);
});

it('attaches read helpers without journaling read steps', async () => {
  const journal = new JournalClient('/unused');
  const start = vi.spyOn(journal, 'runStart').mockResolvedValue({
    run_id: 'completion', status: 'completed', completion_reason: 'success', completed_steps: 1,
  });
  vi.spyOn(journal, 'journalRead').mockResolvedValue({ entries: [{
    entry_type: 'step.completed', step_id: 'complete-1', payload: {
      completionReason: 'success', disposition: 'step_done',
      output: { exit_code: 0, stdout_tail: '', stderr_tail: '' },
    },
  }] } as never);
  const handle = flow('memory-example', { memory: { script: true } }, async f => {
    expect(await f.memory.recall('retry safely')).toHaveLength(1);
    expect(await f.memory.why('retry safely')).toHaveLength(1);
    f.done('success');
  });
  const result = await executeAuthoredFlow(handle, journal, undefined, { flowPath: join(dir, 'test.flow.ts') });
  expect(start).toHaveBeenCalledTimes(1);
  expect(result.journalSteps).toMatchObject([{ id: 'complete-1' }]);
});

it('refuses missing, corrupt, and directory database paths before body or journal activity', async () => {
  const body = vi.fn(async (f: import('@relayflows/surface').Ctx) => f.done('success'));
  const journal = new JournalClient('/unused');
  const start = vi.spyOn(journal, 'runStart');
  writeFileSync(join(dir, 'corrupt.db'), 'not sqlite');
  for (const path of [join(dir, 'missing.db'), join(dir, 'corrupt.db'), dir]) {
    vi.stubEnv('AI_HIST_DB', path);
    await expect(executeAuthoredFlow(flow('missing', { memory: { script: true } }, body), journal))
      .rejects.toMatchObject({ code: 'memory_unreachable' });
  }
  expect(body).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it('detects direct memory use before running earlier body effects', async () => {
  vi.stubEnv('AI_HIST_DB', join(dir, 'missing.db'));
  const effect = vi.fn();
  await expect(executeAuthoredFlow(flow('implicit', async f => {
    effect();
    await f.memory.recall('query');
    f.done('success');
  }), new JournalClient('/unused'))).rejects.toMatchObject({ code: 'memory_unreachable' });
  expect(effect).not.toHaveBeenCalled();
});

it('maps an unavailable provider probe to memory_unreachable', async () => {
  expect(await preflightMemory(async () => { throw new Error('module missing'); }))
    .toMatchObject({ severity: 'refusal', kind: 'memory_unreachable' });
});

function completingJournal(): JournalClient {
  const journal = new JournalClient('/unused');
  vi.spyOn(journal, 'streamAppend').mockImplementation((runId, stream, message) => store.streamAppend(runId, stream, message));
  vi.spyOn(journal, 'streamRead').mockImplementation((runId, stream, from, limit) => store.streamRead(runId, stream, from, limit ?? 100));
  vi.spyOn(journal, 'runStart').mockResolvedValue({
    run_id: 'completion', status: 'completed', completion_reason: 'success', completed_steps: 1,
  });
  vi.spyOn(journal, 'journalRead').mockResolvedValue({ entries: [{
    entry_type: 'step.completed', step_id: 'complete-1', payload: {
      completionReason: 'success', disposition: 'step_done',
      output: { exit_code: 0, stdout_tail: '', stderr_tail: '' },
    },
  }] } as never);
  return journal;
}

it('persists a learned finding that a later run of the same flow recalls', async () => {
  const flowPath = join(dir, 'test.flow.ts');
  const finding = {
    question: 'how should the webhook retry', chosen: 'exponential backoff',
    reasoning: 'the provider rate-limits bursts', alternatives: ['fixed delay'],
  };
  await executeAuthoredFlow(flow('memory-example', { memory: { script: true } }, async f => {
    expect(await f.memory.why('webhook retry')).toEqual([]);
    await f.memory.learn(finding);
    f.done('success');
  }), completingJournal(), undefined, { flowPath, rootRunId: 'root-1' });

  let recalled: unknown[] = [];
  let why: unknown[] = [];
  await executeAuthoredFlow(flow('memory-example', { memory: { script: true } }, async f => {
    recalled = await f.memory.recall('exponential backoff');
    why = await f.memory.why('webhook retry');
    f.done('success');
  }), completingJournal(), undefined, { flowPath, rootRunId: 'root-1' });
  expect(recalled).toMatchObject([{ source: 'trajectory', project: scope }]);
  expect(why).toMatchObject([{ projectId: scope, decisions: [finding] }]);

  // The trajectory file is what a later `ai-hist sync` re-ingests.
  const compacted = compactedDir();
  const [file] = readdirSync(compacted);
  expect(JSON.parse(readFileSync(join(compacted, file!), 'utf8'))).toMatchObject({ projectId: scope, decisions: [finding] });
});

it('learns idempotently and only into its own script scope', async () => {
  const memory = memoryFor(scope);
  const finding = { question: 'cache invalidation', chosen: 'ttl', reasoning: 'simple' };
  await memory.learn(finding);
  await memory.learn(finding);
  expect(await memory.recall('cache invalidation')).toHaveLength(1);
  expect(readdirSync(compactedDir())).toHaveLength(1);
  expect(await memory.recall('retry safely')).toHaveLength(1);

  const other = memoryFor(scriptMemoryScope(join(dir, 'test.flow.ts'), 'another-flow'));
  expect(await other.recall('cache invalidation')).toEqual([]);
  expect(await other.why('cache invalidation')).toEqual([]);
});

it('rejects invalid findings before writing, and unwritable stores', async () => {
  const memory = memoryFor(scope);
  await expect(memory.learn({ question: '', chosen: 'a', reasoning: 'r' }))
    .rejects.toMatchObject({ code: 'memory_finding_invalid' });
  await expect(memory.learn({ question: 'q', chosen: 'a', reasoning: 'r', alternatives: [1] } as never))
    .rejects.toMatchObject({ code: 'memory_finding_invalid' });
  expect(existsSync(join(dir, 'flows-memory'))).toBe(false);
  if (process.getuid?.() !== 0) {
    chmodSync(dir, 0o500);
    try {
      await expect(memory.learn({ question: 'q', chosen: 'a', reasoning: 'r' }))
        .rejects.toMatchObject({ code: 'memory_unwritable' });
    } finally { chmodSync(dir, 0o700); }
  }
});

const dbDigest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');

it('keeps concurrent findings without touching the shared database', async () => {
  const before = dbDigest();
  const memory = memoryFor(scope);
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    memory.learn({ question: `parallel finding ${i}`, chosen: 'c', reasoning: 'r' })));
  expect(await memory.recall('parallel finding')).toHaveLength(6);
  expect(dbDigest()).toBe(before);
  expect(readdirSync(compactedDir()).filter(name => !name.endsWith('.json'))).toEqual([]);
});

it('dedupes a finding once ai-hist sync has indexed it, preferring the synced row', async () => {
  const memory = memoryFor(scope);
  await memory.learn({ question: 'synced finding', chosen: 'c', reasoning: 'r' });
  const [diskEntry] = await memory.recall('synced finding');
  expect(diskEntry).toMatchObject({ source: 'trajectory', project: scope });
  expect(diskEntry!.id).toBeLessThan(0);

  // What `ai-hist sync` writes for the trajectory file.
  const [name] = readdirSync(compactedDir());
  const raw = JSON.parse(readFileSync(join(compactedDir(), name!), 'utf8'));
  const require = createRequire(import.meta.url);
  const SQL = await createRequire(require.resolve('ai-hist/package.json'))('sql.js')();
  const db = new SQL.Database(readFileSync(dbPath));
  const ts = Date.parse(raw.completedAt);
  db.run('INSERT INTO trajectories VALUES (?, 1, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    raw.id, scope, raw.task.title, 'completed', raw.startedAt, raw.completedAt,
    JSON.stringify(raw.decisions), JSON.stringify(raw.retrospective), diskEntry!.prompt, join(compactedDir(), name!), ts, ts]);
  db.run('INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?)', [99, 'trajectory', raw.id, scope, diskEntry!.prompt, ts, null]);
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();

  expect(await memory.recall('synced finding')).toMatchObject([{ id: 99, sessionId: raw.id }]);
  expect(await memory.why('synced finding')).toMatchObject([{ id: raw.id }]);
});

it('applies recall options to findings not yet synced', async () => {
  const memory = memoryFor(scope);
  await memory.learn({ question: 'option finding', chosen: 'c', reasoning: 'r' });
  expect(await memory.recall('option finding', { source: 'claude' })).toEqual([]);
  expect(await memory.recall('option finding', { tag: 'anything' })).toEqual([]);
  expect(await memory.recall('option finding', { beforeMs: 1 })).toEqual([]);
  expect(await memory.recall('', { limit: 1 })).toHaveLength(1);
  expect(await memory.recall('')).toHaveLength(2);
});

it.skipIf(process.platform === 'win32')('gives the trajectory file the database file mode', async () => {
  chmodSync(dbPath, 0o600);
  await memoryFor(scope).learn({ question: 'private', chosen: 'c', reasoning: 'r' });
  expect(statSync(join(compactedDir(), readdirSync(compactedDir())[0]!)).mode & 0o777).toBe(0o600);
});

it('leaves nothing behind when the trajectory cannot be published', async () => {
  const memory = memoryFor(scope);
  failRename = to => to.startsWith(compactedDir()) && to.endsWith('.json');
  try {
    await expect(memory.learn({ question: 'doomed', chosen: 'c', reasoning: 'r' }))
      .rejects.toMatchObject({ code: 'memory_unwritable' });
  } finally { failRename = undefined; }
  expect(readdirSync(compactedDir())).toEqual([]);
  expect(await memory.recall('doomed')).toEqual([]);
});

it('fails the run when the body does not await learn', async () => {
  await expect(executeAuthoredFlow(flow('memory-example', { memory: { script: true } }, async f => {
    void f.memory.learn({ question: 'unawaited', chosen: 'c', reasoning: 'r' });
    f.done('success');
  }), completingJournal(), undefined, { flowPath: join(dir, 'test.flow.ts'), rootRunId: 'root-1' }))
    .rejects.toMatchObject({ code: 'unawaited_step' });
});

it('fails the run for an unawaited learn that already failed before the body returned', async () => {
  await expect(executeAuthoredFlow(flow('memory-example', { memory: { script: true } }, async f => {
    void f.memory.learn({ question: '', chosen: 'c', reasoning: 'r' });
    await new Promise(resolve => setTimeout(resolve, 50));
    f.done('success');
  }), completingJournal(), undefined, { flowPath: join(dir, 'test.flow.ts'), rootRunId: 'root-1' }))
    .rejects.toMatchObject({ code: 'unawaited_step' });
});

it('accepts a learn failure the body awaited and handled', async () => {
  const result = await executeAuthoredFlow(flow('memory-example', { memory: { script: true } }, async f => {
    await f.memory.learn({ question: '', chosen: 'c', reasoning: 'r' }).catch(() => undefined);
    await Promise.all([f.memory.learn({ question: 'all', chosen: 'c', reasoning: 'r' })]);
    f.done('success');
  }), completingJournal(), undefined, { flowPath: join(dir, 'test.flow.ts'), rootRunId: 'root-1' });
  expect(result.completionReason).toBe('success');
});

it('journals the finding on the root run before it becomes recallable, and cites the commit', async () => {
  const finding = { question: 'journal first', chosen: 'c', reasoning: 'r', alternatives: ['x'] };
  await memoryFor(scope).learn(finding);
  expect(store.appended).toEqual([{ stream: MEMORY_LEARN_STREAM, message: expect.objectContaining({
    memory: 'learn', scope, decision: finding,
  }), fileExisted: false }]);
  const [name] = readdirSync(compactedDir());
  expect(JSON.parse(readFileSync(join(compactedDir(), name!), 'utf8')))
    .toMatchObject({ journal: { runId: 'root-1', stream: MEMORY_LEARN_STREAM, offset: 0 }, decisions: [finding] });
});

it('refuses to learn without a durable root run, writing nothing', async () => {
  await expect(authoredMemory(scope, () => {}, true).learn({ question: 'q', chosen: 'c', reasoning: 'r' }))
    .rejects.toMatchObject({ code: 'memory_unjournaled' });
  await expect(executeAuthoredFlow(flow('memory-example', { memory: { script: true } }, async f => {
    await f.memory.learn({ question: 'q', chosen: 'c', reasoning: 'r' });
    f.done('success');
  }), completingJournal(), undefined, { flowPath: join(dir, 'test.flow.ts') }))
    .rejects.toMatchObject({ code: 'memory_unjournaled' });
  expect(existsSync(join(dir, 'flows-memory'))).toBe(false);
});

it('publishes nothing when the journal append fails', async () => {
  vi.spyOn(store, 'streamAppend').mockRejectedValueOnce(new Error('journal down'));
  const memory = memoryFor(scope);
  await expect(memory.learn({ question: 'not journaled', chosen: 'c', reasoning: 'r' }))
    .rejects.toMatchObject({ code: 'memory_unwritable', message: expect.stringContaining('could not journal') });
  expect(existsSync(join(dir, 'flows-memory'))).toBe(false);
  expect(await memory.recall('not journaled')).toEqual([]);
});

it('on resume, republishes a journaled finding from its commit without journaling it again', async () => {
  const finding = { question: 'resumed finding', chosen: 'c', reasoning: 'r', alternatives: [] };
  await memoryFor(scope).learn(finding);
  const [name] = readdirSync(compactedDir());
  const published = readFileSync(join(compactedDir(), name!), 'utf8');
  // The crash window: journaled, but the file never landed.
  rmSync(join(compactedDir(), name!));
  // A resumed body is a new execution: a fresh ledger reading the same root stream.
  const resumed = memoryFor(scope);
  expect(await resumed.recall('resumed finding')).toEqual([]);
  await resumed.learn(finding);
  expect(store.list('root-1', MEMORY_LEARN_STREAM)).toHaveLength(1);
  expect(readFileSync(join(compactedDir(), name!), 'utf8')).toBe(published);
  expect(await resumed.recall('resumed finding')).toHaveLength(1);
});

it('journals concurrent learns of one finding once', async () => {
  const memory = memoryFor(scope);
  const finding = { question: 'same finding', chosen: 'c', reasoning: 'r' };
  await Promise.all([memory.learn(finding), memory.learn(finding), memory.learn(finding)]);
  expect(store.list('root-1', MEMORY_LEARN_STREAM)).toHaveLength(1);
});

it('fails recall closed on a damaged learned file instead of skipping it', async () => {
  const memory = memoryFor(scope);
  await memory.learn({ question: 'damaged', chosen: 'c', reasoning: 'r' });
  const [name] = readdirSync(compactedDir());
  writeFileSync(join(compactedDir(), name!), '{ not json');
  await expect(memory.recall('damaged')).rejects.toMatchObject({ code: 'memory_unreachable' });
});

it('keeps learned files out of the flow source directory', async () => {
  await memoryFor(scope).learn({ question: 'placement', chosen: 'c', reasoning: 'r' });
  expect(existsSync(scope)).toBe(false);
  expect(readdirSync(compactedDir())).toHaveLength(1);
});

it('reports learn failures with their own kind, not protocol_error', () => {
  for (const code of ['memory_finding_invalid', 'memory_unwritable', 'memory_unjournaled'] as const) {
    const error = Object.assign(new AuthoredFlowExecutionError(code, 'nope'), { rootRunId: 'root-1' });
    expect(memoryWriteFailure('run', emptyReport('run'), '/sock', error)).toMatchObject({ exitCode: 1, report: {
      runId: 'root-1', rootRunId: 'root-1', status: 'failed', completionReason: 'step_failed',
      diagnostics: [{ severity: 'failure', kind: code }],
    } });
  }
  expect(memoryWriteFailure('run', emptyReport('run'), '/sock', new AuthoredFlowExecutionError('step_failed', 'x'))).toBeUndefined();
});

it('fails closed for agent scope, disabled script memory, and memory use after done', async () => {
  await expect(authoredMemory(scope, () => {}, false).recall('q'))
    .rejects.toMatchObject({ code: 'unsupported_header' });
  await expect(authoredMemory(scope, () => {}, false).learn({ question: 'q', chosen: 'a', reasoning: 'r' }))
    .rejects.toMatchObject({ code: 'unsupported_header' });
  await expect(executeAuthoredFlow(flow('agent', { memory: { agent: true } }, async f => f.done('success')), new JournalClient('/unused')))
    .rejects.toMatchObject({ code: 'unsupported_header' });
  await expect(executeAuthoredFlow(flow('closed', async f => {
    f.done('success');
    await f.memory.recall('q');
  }), new JournalClient('/unused'))).rejects.toMatchObject({ code: 'operation_after_completion' });
});
