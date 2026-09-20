import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const repo = resolve(process.argv[2]);
const { JournalClient } = await import(pathToFileURL(join(repo, 'packages/sdk/dist/journal-client.js')));
const { socketPathFor } = await import(pathToFileURL(join(repo, 'packages/sdk/dist/daemon-connection.js')));
const root = mkdtempSync(join(tmpdir(), 'event-await-cli-'));
const data = join(root, 'data');
mkdirSync(join(root, 'node_modules', '@relayflows'), { recursive: true });
symlinkSync(join(repo, 'packages/surface'), join(root, 'node_modules', '@relayflows', 'surface'));
writeFileSync(join(root, 'package.json'), '{"type":"module"}');
writeFileSync(join(root, 'await.flow.ts'), `import {flow,webhook} from '@relayflows/surface';
export default flow('event-await-cli', async f => {
  await f.run('printf setup, >> effects');
  const activity = f.on(webhook('e2e_event'), {idle:'1h',deadline:'1d'});
  for (let index=0; index<2; index++) {
    const wake=await activity.next();
    if(wake.kind!=='events'||wake.events.length!==1||wake.events[0].payload.index!==index)
      throw new Error('wrong replayed event at '+index);
    await f.run('printf event'+index+', >> effects');
  }
  f.done('success');
});`);

function invoke(...args) {
  const result = spawnSync(process.execPath, [join(repo, 'packages/sdk/dist/cli.js'), ...args,
    '--data-dir', data, '--json', '--no-observer-link'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  console.log(JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }));
  if (result.error) throw result.error;
  return { status: result.status, report: JSON.parse(result.stdout) };
}

let client;
function stopDaemon(signal) {
  client?.close();
  client = undefined;
  const connection = join(data, 'connection.json');
  if (existsSync(connection)) {
    const { pid } = JSON.parse(readFileSync(connection, 'utf8'));
    try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
async function connect() {
  client = new JournalClient(socketPathFor(data));
  await client.connect();
  await client.hello('event-await-cli-probe');
}
function expectPark(result, phase) {
  assert.equal(result.status, 4);
  assert.equal(result.report.suspension.kind, phase);
}
try {
  const first = invoke('run', 'await.flow.ts', '--input', '{}');
  expectPark(first, 'activation');
  const id = first.report.runId;
  // More resumes than the root's retry budget: none are failures or new work.
  for (let index = 0; index < 10; index++) expectPark(invoke('resume', id), 'activation');
  await connect();
  await client.subscriptionActivate({ run_id: id, subscription_id: 'activity-1', ingress_offset: 0,
    router_binding: { transport: 'local-test-router', generation: 'cli' } });
  expectPark(invoke('resume', id), 'event_wait');
  stopDaemon('SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 100));
  expectPark(invoke('resume', id), 'event_wait');
  await connect();
  assert.equal((await client.eventEmit(id, 'e2e_event', { index: 0 }, { delivery_id: 'first', actor: 'tester' })).matched, 1);
  expectPark(invoke('resume', id), 'event_wait');
  assert.equal(readFileSync(join(root, 'effects'), 'utf8'), 'setup,event0,');
  assert.equal((await client.eventEmit(id, 'e2e_event', { index: 0 }, { delivery_id: 'first', actor: 'tester' })).matched, 0);
  assert.equal((await client.eventEmit(id, 'e2e_event', { index: 1 }, { delivery_id: 'second', actor: 'tester' })).matched, 1);
  assert.equal(invoke('resume', id).status, 0);
  assert.equal(invoke('resume', id).status, 0);
  assert.equal(readFileSync(join(root, 'effects'), 'utf8'), 'setup,event0,event1,');
  const { entries } = await client.journalRead(id, 1, 500);
  assert.equal(entries.filter(entry => entry.entry_type === 'step.completed'
    && entry.payload.completionReason === 'crashed').length, 0);
  console.log('E2E_PASS: repeated park, SIGKILL/restart, two wakes replayed in order, deduped delivery, exactly-once child effects, zero crash retries');
} finally {
  stopDaemon('SIGTERM');
  rmSync(root, { recursive: true, force: true });
}
