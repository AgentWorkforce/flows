import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flow } from '@relayflows/surface';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let failRenameTo: string | undefined;
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (to === failRenameTo) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return actual.rename(from, to);
    },
  };
});
import { openAiHist } from 'ai-hist';
import { authoredMemory, scriptMemoryScope } from '../src/authored-memory.js';
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

it('reads the seeded local SQLite database with cloud unused and fallback disabled', async () => {
  const db = await openAiHist({ dbPath, projectScope: scope, fallback: 'error' });
  try { expect(db.search('retry safely')).toHaveLength(1); } finally { db.close(); }
  const memory = authoredMemory(scope, () => {}, true);
  expect(await memory.recall('retry safely')).toMatchObject([{ id: 1, project: scope }]);
  expect(await memory.why('retry safely')).toMatchObject([{
    id: 'run-1', decisions: [{ chosen: 'idempotency key', reasoning: 'avoid duplicate writes' }],
  }]);
  expect(await memory.recall('no match')).toEqual([]);
  expect(await memory.why('no match')).toEqual([]);
});

it('cannot widen script scope using a raw project option or another flow name', async () => {
  const memory = authoredMemory(scope, () => {}, true);
  expect(await memory.recall('', { project: `${scope}-other` } as never)).toMatchObject([{ id: 1 }]);
  const other = authoredMemory(scriptMemoryScope(join(dir, 'test.flow.ts'), 'another-flow'), () => {}, true);
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
  }), completingJournal(), undefined, { flowPath });

  let recalled: unknown[] = [];
  let why: unknown[] = [];
  await executeAuthoredFlow(flow('memory-example', { memory: { script: true } }, async f => {
    recalled = await f.memory.recall('exponential backoff');
    why = await f.memory.why('webhook retry');
    f.done('success');
  }), completingJournal(), undefined, { flowPath });
  expect(recalled).toMatchObject([{ source: 'trajectory', project: scope }]);
  expect(why).toMatchObject([{ projectId: scope, decisions: [finding] }]);

  // The trajectory file is what a later `ai-hist sync` re-ingests.
  const compacted = join(scope, '.trajectories', 'compacted');
  const [file] = readdirSync(compacted);
  expect(JSON.parse(readFileSync(join(compacted, file!), 'utf8'))).toMatchObject({ projectId: scope, decisions: [finding] });
});

it('learns idempotently and only into its own script scope', async () => {
  const memory = authoredMemory(scope, () => {}, true);
  const finding = { question: 'cache invalidation', chosen: 'ttl', reasoning: 'simple' };
  await memory.learn(finding);
  await memory.learn(finding);
  expect(await memory.recall('cache invalidation')).toHaveLength(1);
  expect(readdirSync(join(scope, '.trajectories', 'compacted'))).toHaveLength(1);
  expect(await memory.recall('retry safely')).toHaveLength(1);

  const other = authoredMemory(scriptMemoryScope(join(dir, 'test.flow.ts'), 'another-flow'), () => {}, true);
  expect(await other.recall('cache invalidation')).toEqual([]);
  expect(await other.why('cache invalidation')).toEqual([]);
});

it('rejects invalid findings before writing, and unwritable stores', async () => {
  const memory = authoredMemory(scope, () => {}, true);
  await expect(memory.learn({ question: '', chosen: 'a', reasoning: 'r' }))
    .rejects.toMatchObject({ code: 'memory_finding_invalid' });
  await expect(memory.learn({ question: 'q', chosen: 'a', reasoning: 'r', alternatives: [1] } as never))
    .rejects.toMatchObject({ code: 'memory_finding_invalid' });
  expect(existsSync(join(scope, '.trajectories'))).toBe(false);
  if (process.getuid?.() !== 0) {
    chmodSync(dir, 0o500);
    try {
      await expect(memory.learn({ question: 'q', chosen: 'a', reasoning: 'r' }))
        .rejects.toMatchObject({ code: 'memory_unwritable' });
    } finally { chmodSync(dir, 0o700); }
  }
});

it('serializes concurrent learns so no finding is lost from the database', async () => {
  const memory = authoredMemory(scope, () => {}, true);
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    memory.learn({ question: `parallel finding ${i}`, chosen: 'c', reasoning: 'r' })));
  expect(await memory.recall('parallel finding')).toHaveLength(6);
  expect(existsSync(`${dbPath}.flows-memory.lock`)).toBe(false);
});

it('waits for a live lock and breaks a stale one', async () => {
  const lock = `${dbPath}.flows-memory.lock`;
  writeFileSync(lock, '');
  const memory = authoredMemory(scope, () => {}, true);
  let settled = false;
  const pending = memory.learn({ question: 'locked finding', chosen: 'c', reasoning: 'r' }).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(settled).toBe(false);
  rmSync(lock);
  await pending;
  expect(await memory.recall('locked finding')).toHaveLength(1);

  writeFileSync(lock, '');
  const { utimesSync } = await import('node:fs');
  utimesSync(lock, new Date(0), new Date(0));
  await memory.learn({ question: 'after stale lock', chosen: 'c', reasoning: 'r' });
  expect(await memory.recall('after stale lock')).toHaveLength(1);
});

it.skipIf(process.platform === 'win32')('keeps the database file mode', async () => {
  chmodSync(dbPath, 0o600);
  await authoredMemory(scope, () => {}, true).learn({ question: 'private', chosen: 'c', reasoning: 'r' });
  expect(statSync(dbPath).mode & 0o777).toBe(0o600);
});

it('migrates a pre-handoff history table without git_branch', async () => {
  const require = createRequire(import.meta.url);
  const SQL = await createRequire(require.resolve('ai-hist/package.json'))('sql.js')();
  const db = new SQL.Database();
  db.run('CREATE TABLE history (id INTEGER PRIMARY KEY, source TEXT, session_id TEXT, project TEXT, prompt TEXT, timestamp_ms INTEGER)');
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  const memory = authoredMemory(scope, () => {}, true);
  await memory.learn({ question: 'old database', chosen: 'c', reasoning: 'r' });
  expect(await memory.recall('old database')).toMatchObject([{ source: 'trajectory', gitBranch: null }]);
});

it('removes the trajectory file when the database replace fails', async () => {
  const memory = authoredMemory(scope, () => {}, true);
  failRenameTo = dbPath;
  try {
    await expect(memory.learn({ question: 'doomed', chosen: 'c', reasoning: 'r' }))
      .rejects.toMatchObject({ code: 'memory_unwritable' });
  } finally { failRenameTo = undefined; }
  expect(readdirSync(join(scope, '.trajectories', 'compacted'))).toEqual([]);
  expect(readdirSync(dir).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  expect(await memory.recall('doomed')).toEqual([]);
});

it('reports learn failures with their own kind, not protocol_error', () => {
  for (const code of ['memory_finding_invalid', 'memory_unwritable'] as const) {
    const execution = memoryWriteFailure('run', emptyReport('run'), '/sock', new AuthoredFlowExecutionError(code, 'nope'), 'run-1');
    expect(execution).toMatchObject({ exitCode: 1, report: { runId: 'run-1', diagnostics: [{ severity: 'failure', kind: code }] } });
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
