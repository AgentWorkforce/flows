import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flow } from '@relayflows/surface';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openAiHist } from 'ai-hist';
import { authoredMemory, scriptMemoryScope } from '../src/authored-memory.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
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

it('fails closed for deferred writes, agent scope, disabled script memory, and reads after done', async () => {
  await expect(authoredMemory(scope, () => {}, true).learn({ question: 'q', chosen: 'a', reasoning: 'r' }))
    .rejects.toMatchObject({ code: 'unsupported_verb' });
  await expect(authoredMemory(scope, () => {}, false).recall('q'))
    .rejects.toMatchObject({ code: 'unsupported_header' });
  await expect(executeAuthoredFlow(flow('agent', { memory: { agent: true } }, async f => f.done('success')), new JournalClient('/unused')))
    .rejects.toMatchObject({ code: 'unsupported_header' });
  await expect(executeAuthoredFlow(flow('closed', async f => {
    f.done('success');
    await f.memory.recall('q');
  }), new JournalClient('/unused'))).rejects.toMatchObject({ code: 'operation_after_completion' });
});
