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
  return invokeWithin(30_000, args);
}
function invokeWithin(timeout, args) {
  const result = spawnSync(process.execPath, [join(repo, 'packages/sdk/dist/cli.js'), ...args,
    '--data-dir', data, '--json', '--no-observer-link'], { cwd: root, encoding: 'utf8', timeout });
  console.log(JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }));
  if (result.error) throw result.error;
  assert.notEqual(result.stdout.trim(), '',
    `flows ${args[0]} exited ${result.status} without a JSON report: ${result.stderr}`);
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
  assert.equal(first.report.subscriptions[0].state, 'prepared');
  // More resumes than the root's retry budget: none are failures or new work.
  for (let index = 0; index < 10; index++) expectPark(invoke('resume', id), 'activation');
  await connect();
  await client.subscriptionActivate({ run_id: id, subscription_id: 'activity-1', ingress_offset: 0,
    router_binding: { transport: 'local-test-router', generation: 'cli' } });
  const waiting = invoke('resume', id);
  expectPark(waiting, 'event_wait');
  assert.equal(waiting.report.subscriptions[0].state, 'active');
  assert.equal(waiting.report.suspension.idleAtMs, waiting.report.subscriptions[0].idleAtMs);
  assert.equal(waiting.report.suspension.settleMs, waiting.report.subscriptions[0].settleMs);
  assert.equal(waiting.report.subscriptions[0].routerBinding.generation, 'cli');
  stopDaemon('SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 100));
  const restarted = invoke('resume', id);
  expectPark(restarted, 'event_wait');
  assert.equal(restarted.report.suspension.idleAtMs, waiting.report.suspension.idleAtMs);
  await connect();
  assert.equal((await client.eventEmit(id, 'e2e_event', { index: 0 }, { delivery_id: 'first', actor: 'tester' })).matched, 1);
  expectPark(invoke('resume', id), 'event_wait');
  assert.equal(readFileSync(join(root, 'effects'), 'utf8'), 'setup,event0,');
  assert.equal((await client.eventEmit(id, 'e2e_event', { index: 0 }, { delivery_id: 'first', actor: 'tester' })).matched, 0);
  assert.equal((await client.eventEmit(id, 'e2e_event', { index: 1 }, { delivery_id: 'second', actor: 'tester' })).matched, 1);
  const done = invoke('resume', id);
  assert.equal(done.status, 0);
  assert.equal(done.report.subscriptions[0].state, 'closed');
  assert.equal(invoke('resume', id).status, 0);
  const replayed = spawnSync(process.execPath, [join(repo, 'packages/sdk/dist/cli.js'), 'replay', id, '--data-dir', data, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.ok(replayed.stdout.includes('subscription.prepared'));
  assert.ok(replayed.stdout.includes('subscription.closed'));
  assert.equal(readFileSync(join(root, 'effects'), 'utf8'), 'setup,event0,event1,');
  const { entries } = await client.journalRead(id, 1, 500);
  assert.equal(entries.filter(entry => entry.entry_type === 'step.completed'
    && entry.payload.completionReason === 'crashed').length, 0);
  // Metadata belongs to the authored root even when failure diagnostics name
  // a child, and remains available while an unrelated human wait parks it.
  const authoredFailureDetail = 'event-await proof rejected the delivered frame';
  for (const [name, tail, expectedStatus] of [
    ['human', "await f.human('Proceed?', {to:'khaliq'});", 3],
    ['failed', `return f.done('step_failed', {detail:${JSON.stringify(authoredFailureDetail)}});`, 1],
  ]) {
    writeFileSync(join(root, `${name}.flow.ts`), `import {flow,webhook} from '@relayflows/surface';
export default flow('${name}-subscription-report', async f => {
  const activity = f.on(webhook('metadata_event'), {idle:'1h',deadline:'1d'});
  await activity.next();
  ${tail}
  f.done('success');
});`);
    const admitted = invoke('run', `${name}.flow.ts`, '--input', '{}');
    expectPark(admitted, 'activation');
    const rootId = admitted.report.runId;
    await client.subscriptionActivate({run_id:rootId,subscription_id:'activity-1',ingress_offset:0,
      router_binding:{generation:name, transport:'local-test-router'}});
    expectPark(invoke('resume', rootId), 'event_wait');
    await client.subscriptionDeliver({run_id:rootId,subscription_id:'activity-1',
      router_binding:{generation:name, transport:'local-test-router'},delivery_id:name,
      frame:{type:'metadata_event',payload:{}}});
    const boundary = invoke('resume', rootId);
    assert.equal(boundary.status, expectedStatus);
    assert.equal(boundary.report.rootRunId, rootId);
    assert.equal(boundary.report.subscriptions.length, 1);
    assert.equal(boundary.report.subscriptions[0].state, name === 'failed' ? 'closed' : 'active');
    if (name === 'failed') {
      assert.equal(boundary.report.completionReason, 'step_failed');
      assert.equal(boundary.report.completionDetail, authoredFailureDetail);
      const failureDiagnostic = boundary.report.diagnostics.find(entry => entry.kind === 'step_failed');
      assert.equal(failureDiagnostic.detail, authoredFailureDetail);
      const { entries: failureEntries } = await client.journalRead(rootId, 1, 500);
      assert.equal(failureEntries.filter(entry => entry.entry_type === 'step.completed'
        && entry.payload.completionReason === 'worker_error').length, 0);
      const rootCompletion = failureEntries.find(entry => entry.entry_type === 'step.completed');
      assert.equal(rootCompletion.payload.output.completionReason, 'step_failed');
      assert.equal(rootCompletion.payload.output.completionDetail, authoredFailureDetail);
      const verdict = await client.streamRead(rootId, 'authored-verdict', 0, 10);
      assert.deepEqual(verdict.messages.map(message => message.message ?? message), [{
        verdict: 'relayflows.authored-verdict.v1', step: 'complete-1',
        reason: 'step_failed', detail: authoredFailureDetail,
      }]);
    }
  }
  console.log('E2E_PASS: repeated park, SIGKILL/restart, two wakes replayed in order, deduped delivery, exactly-once child effects, durable authored failure verdict, zero crash retries');
} finally {
  stopDaemon('SIGTERM');
  rmSync(root, { recursive: true, force: true });
}
