import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_LEARN_STREAM, scriptMemoryScope } from '../src/authored-memory.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  delete process.env.AI_HIST_DB;
});

describe('f.memory.learn through the built CLI and a real kernel', () => {
  it('journals the finding on the root run, then a later run of the same flow recalls it', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const dbPath = join(fixture.root, 'ai-history.db');
    const scope = scriptMemoryScope(fixture.flowPath, 'learner');
    execFileSync(process.execPath, [resolve('../../testdata/memory/seed.mjs'), dbPath, scope]);
    process.env.AI_HIST_DB = dbPath;

    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('learner', { memory: { script: true } }, async f => {
  await f.memory.learn({ question: 'how should the importer page', chosen: 'cursor pagination',
    reasoning: 'offsets skip rows under concurrent inserts', alternatives: ['offset pagination'] });
  f.done('success');
});
`);
    const learned = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data, fixture.flowPath, '--input', '{}');
    expect(learned.status, learned.stderr + learned.stdout).toBe(0);
    const report = JSON.parse(learned.stdout) as { runId: string; completionReason: string };
    expect(report.completionReason).toBe('success');

    const journal = new JournalClient(socketPathFor(fixture.data));
    await journal.connect();
    await journal.hello('memory-learn-live-test');
    const records = (await journal.streamRead(report.runId, MEMORY_LEARN_STREAM, 0, 1000)).messages
      .map(message => (message as { message?: unknown }).message ?? message) as Array<Record<string, unknown>>;
    journal.close();
    expect(records).toMatchObject([{ memory: 'learn', scope, decision: { chosen: 'cursor pagination' } }]);

    const compacted = join(fixture.root, 'flows-memory', basename(scope), '.trajectories', 'compacted');
    const [file] = readdirSync(compacted);
    expect(JSON.parse(readFileSync(join(compacted, file!), 'utf8')))
      .toMatchObject({ id: records[0]!.id, journal: { runId: report.runId, stream: MEMORY_LEARN_STREAM, offset: 0 } });
    expect(existsSync(scope)).toBe(false);

    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('learner', { memory: { script: true } }, async f => {
  const [why] = await f.memory.why('importer page');
  const hits = await f.memory.recall('cursor pagination');
  f.done(why?.decisions[0]?.chosen === 'cursor pagination' && hits.length === 1 ? 'success' : 'step_failed');
});
`);
    const recalled = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data, fixture.flowPath, '--input', '{}');
    expect(recalled.status, recalled.stderr + recalled.stdout).toBe(0);
    expect(JSON.parse(recalled.stdout)).toMatchObject({ completionReason: 'success' });
  }, 60_000);
});
