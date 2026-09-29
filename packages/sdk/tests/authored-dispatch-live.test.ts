import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHORED_STEP_STREAM } from '../src/authored-step-index.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { readJournalEvents } from '../src/cloud-mirror.js';
import { mirrorJournal } from '../src/cloud-mirror-step.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

describe('durable child flow dispatch', () => {
  it('runs a declared child in the parent DAG and replays it without repeating effects', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const grandchildPath = `${fixture.root}/grandchild.flow.ts`;
    writeFileSync(grandchildPath, `import { flow } from '@relayflows/surface';
export default flow('grandchild', async (f, input: { word: string }) => {
  await f.run(\`printf '%s' \"\${input.word}\" >> effects\`);
  f.done('success');
});
`);
    const childPath = `${fixture.root}/child.flow.ts`;
    writeFileSync(childPath, `import { flow } from '@relayflows/surface';
export default flow('child', { use: ['./grandchild.flow.ts'] }, async (f, input: { word: string }) => {
  await f.dispatch('grandchild', { word: 'grandchild' });
  await f.run(\`printf '%s' \"\${input.word}\" >> effects\`);
  f.done('success');
});
`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('parent', { use: ['./child.flow.ts'] }, async f => {
  await f.run("printf '%s' before >> effects");
  const child = await f.dispatch('child', { word: 'child' });
  await f.run("printf '%s' after >> effects");
  f.done(child.name === 'child' ? 'success' : 'step_failed');
});
`);

    const first = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const report = JSON.parse(first.stdout) as { runId: string; completionReason: string };
    expect(report.completionReason).toBe('success');
    expect(readFileSync(`${fixture.root}/effects`, 'utf8')).toBe('beforegrandchildchildafter');

    const journal = new JournalClient(socketPathFor(fixture.data));
    await journal.connect();
    await journal.hello('dispatch-live-test');
    const messages = (await journal.streamRead(report.runId, AUTHORED_STEP_STREAM, 0, 1000)).messages
      .map(message => (message as { message?: unknown }).message ?? message) as Array<Record<string, unknown>>;
    journal.close();
    const completed = messages.filter(record => record['state'] === 'completed');
    expect(completed.map(record => record['step'])).toEqual([
      'run-1',
      'dispatch-2--dispatch-1--run-1',
      'dispatch-2--dispatch-1--complete-2',
      'dispatch-2--dispatch-1',
      'dispatch-2--run-2',
      'dispatch-2--complete-3',
      'dispatch-2',
      'run-3',
      'complete-4',
    ]);
    expect(Object.fromEntries(completed.map(record => [record['step'], {
      label: record['label'], after: record['after'],
    }]))).toEqual({
      'run-1': { label: undefined, after: undefined },
      'dispatch-2--dispatch-1--run-1': { label: undefined, after: ['run-1'] },
      'dispatch-2--dispatch-1--complete-2': { label: undefined, after: undefined },
      'dispatch-2--dispatch-1': { label: 'grandchild', after: ['dispatch-2--dispatch-1--run-1'] },
      'dispatch-2--run-2': { label: undefined, after: ['dispatch-2--dispatch-1'] },
      'dispatch-2--complete-3': { label: undefined, after: undefined },
      'dispatch-2': { label: 'child', after: ['dispatch-2--run-2'] },
      'run-3': { label: undefined, after: ['dispatch-2'] },
      'complete-4': { label: undefined, after: undefined },
    });
    const folded = mirrorJournal(report.runId,
      await readJournalEvents(report.runId, fixture.data), Date.now(), process.env);
    const runIds = Object.fromEntries(completed.map(record => [record['step'], record['runId']])) as Record<string, string>;
    expect(Object.fromEntries([
      'run-1', 'dispatch-2--dispatch-1--run-1', 'dispatch-2--dispatch-1',
      'dispatch-2--run-2', 'dispatch-2', 'run-3',
    ].map(step => [step, folded.hints.get(`${runIds[step]}/${step}`)]))).toEqual({
      'run-1': undefined,
      'dispatch-2--dispatch-1--run-1': { after: ['run-1'] },
      'dispatch-2--dispatch-1': { label: 'grandchild', after: ['dispatch-2--dispatch-1--run-1'] },
      'dispatch-2--run-2': { after: ['dispatch-2--dispatch-1'] },
      'dispatch-2': { label: 'child', after: ['dispatch-2--run-2'] },
      'run-3': { after: ['dispatch-2'] },
    });

    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, report.runId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(readFileSync(`${fixture.root}/effects`, 'utf8')).toBe('beforegrandchildchildafter');
    expect(existsSync(childPath)).toBe(true);
    expect(existsSync(grandchildPath)).toBe(true);
  }, 90_000);

  it('lowers a named gate attached to the dispatch receipt', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(`${fixture.root}/child.flow.ts`, `import { flow } from '@relayflows/surface';
export default flow('child', async f => { f.done('success'); });
`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('parent', { use: ['./child.flow.ts'] }, async f => {
  await f.dispatch('child', {}).gate({ type: 'regex_match', pattern: '^NEVER_MATCHES$' });
  f.done('success');
});
`);

    const run = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(run.status, run.stderr + run.stdout).toBe(1);
    expect(run.stdout).toContain('dispatch-1.gate');
    expect(run.stdout).toContain('retries_exhausted');
  }, 90_000);
});
