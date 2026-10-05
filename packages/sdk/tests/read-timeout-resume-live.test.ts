import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { loadAuthoredFlow } from '../src/authored-flow-loader.js';
import { executeDurableAuthoredFlow, resumeDurableAuthoredFlow } from '../src/authored-root.js';
import { LlmWorker } from '../src/llm-worker.js';
import { chainFixture, shellWord } from './flow-chain-fixture.js';

it('parks an unreadable authored root and resumes without repeating its journaled effect', async () => {
  const fixture = chainFixture();
  const journal = await fixture.connect();
  const { pid } = JSON.parse(readFileSync(join(fixture.data, 'connection.json'), 'utf8'));
  const worker = new LlmWorker(journal, 'park-read-worker');
  const client = new JournalClient(journal.socketPath, { requestTimeoutMs: 100, readBudgetMs: 500 });
  const effects = join(fixture.root, 'effects');
  writeFileSync(fixture.flowPath, `import {flow} from '@relayflows/surface';
export default flow('park-read', async f => {
  await f.run(${JSON.stringify(`echo saved >> ${shellWord(effects)}`)});
  await f.llm('hello', {model:'test-model', output:{type:'object'}});
  await f.run(${JSON.stringify(`echo after >> ${shellWord(effects)}`)});
  f.done('success');
});
`);
  const get = client.runGet.bind(client);
  let interrupted = false;
  // Suspend service exactly when the body first reads its running child. The
  // request and retry timers are real; no synthetic rejection is injected.
  client.runGet = runId => {
    if (!interrupted) { interrupted = true; process.kill(pid, 'SIGSTOP'); }
    return get(runId);
  };
  let rootRunId = '';
  try {
    await client.connect();
    await worker.attach();
    const loaded = await loadAuthoredFlow(fixture.flowPath);
    try {
      await expect(executeDurableAuthoredFlow(loaded, client, undefined, {
        dataDir: fixture.data, admissionKey: 'park-read', onAdmitted: id => { rootRunId = id; },
      })).rejects.toMatchObject({ code: 'daemon_unresponsive', rootRunId: expect.any(String) });
    } finally { process.kill(pid, 'SIGCONT'); client.runGet = get; }
    expect(interrupted).toBe(true);
    expect(readFileSync(effects, 'utf8')).toBe('saved\n');
    const entries = (await journal.journalRead(rootRunId, 1, 1000)).entries as Array<{
      entry_type: string; step_id: string; payload: { completionReason?: string };
    }>;
    expect(entries.some(entry => entry.step_id === 'authored-root'
      && entry.entry_type === 'step.completed' && entry.payload.completionReason === 'worker_error')).toBe(false);
    expect(await resumeDurableAuthoredFlow(rootRunId, client, { dataDir: fixture.data }))
      .toMatchObject({ rootRunId, completionReason: 'success' });
    expect(readFileSync(effects, 'utf8')).toBe('saved\nafter\n');
    expect(await journal.runGet(rootRunId)).toMatchObject({ status: 'completed' });
  } finally {
    process.kill(pid, 'SIGCONT');
    client.close();
    await worker.close();
    await fixture.close();
  }
}, 30_000);
