import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHORED_STEP_STREAM } from '../src/authored-step-index.js';
import { readCompletedStepOutput } from '../src/authored-step-output.js';
import type { AuthoredFlowJournalStep } from '../src/authored-flow-executor.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { SPEC_SCHEMA_VERSION } from '../src/spec.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

async function until(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function killDaemon(data: string): void {
  const { pid } = JSON.parse(readFileSync(join(data, 'connection.json'), 'utf8')) as { pid: number };
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * The Cloud executor e2e that found this: an authored flow killed in the
 * middle of its second `f.run` (CLI and relayflowd both), then `flows resume`
 * on the same data dir. Crash recovery journals the dead attempt as
 * `step.completed {completionReason: crashed, disposition: retry}` and a
 * second attempt then succeeds. The authored reader took the FIRST
 * `step.completed` for the step and threw `completed with crashed` over a
 * child run that had completed `success`.
 */
describe('an authored step whose child run retried an attempt', () => {
  it('resumes after a kill mid-step and reads the terminal completion, not the crashed one', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('killed-mid-step', async f => {
  await f.run('echo ran >> count');
  await f.run('test -f marker || { touch marker; sleep 120; }', { timeout: '5m' });
  f.done('success');
});
`);
    const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
    await until(() => existsSync(join(fixture.root, 'marker')), 'the second step to start');
    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);

    // Runs are ULIDs, so the root — admitted before any child — sorts first.
    const runs = readdirSync(join(fixture.data, 'runs'))
      .filter(name => name.endsWith('.sqlite3')).map(name => name.slice(0, -'.sqlite3'.length)).sort();
    const rootRunId = runs[0]!;

    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    const report = JSON.parse(resumed.stdout) as { completionReason?: string };
    expect(report.completionReason).toBe('success');
    // The completed first step was replayed from its receipt, not re-run.
    expect(readFileSync(join(fixture.root, 'count'), 'utf8')).toBe('ran\n');

    const journal = new JournalClient(socketPathFor(fixture.data));
    await journal.connect();
    await journal.hello('retried-child-test');
    try {
      const records = (await journal.streamRead(rootRunId, AUTHORED_STEP_STREAM, 0, 1000)).messages
        .map(message => (message as { message?: unknown }).message ?? message) as Array<Record<string, unknown>>;
      const completed = records.filter(record => record['state'] === 'completed');
      // Only the terminal completion is indexed: never the retried `crashed`.
      expect(completed.filter(record => record['step'] === 'run-2')
        .map(record => record['completionReason'])).toEqual(['success']);

      // And the child really did retry, so the test exercised the bug.
      const childRunId = completed.find(record => record['step'] === 'run-2')!['runId'] as string;
      const entries = (await journal.journalRead(childRunId, 1, 1000)).entries as Array<{
        entry_type: string; payload?: { completionReason?: string; disposition?: string };
      }>;
      expect(entries.filter(entry => entry.entry_type === 'step.completed')
        .map(entry => [entry.payload?.completionReason, entry.payload?.disposition]))
        .toEqual([['crashed', 'retry'], ['success', 'step_done']]);
    } finally {
      journal.close();
    }
  }, 120_000);

  it('reads the terminal completion with no daemon restart or flows resume, when a worker died mid-attempt', async () => {
    // The ordinary path, no daemon restart and no `flows resume`: a worker
    // holding an agent attempt disconnects, the kernel journals the attempt
    // `crashed` with `disposition: retry` (a dead attempt charges no
    // iteration, so even `max_iterations: 1` retries it), and a second
    // worker completes it. This is what `f.agent`, helper and MCP children
    // read through the same function.
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const journal = await fixture.connect();
    const stream = 'retried-agent-stream';
    const spec = toKernelSpec(compileSpec({
      version: SPEC_SCHEMA_VERSION, name: 'retried-agent',
      steps: [{ id: 'agent-1', type: 'agent', instruction: 'do it', maxIterations: 1, recoveryMode: 'reset',
        surfaces: { streams: [{ stream }] } }],
    }));
    const attach = async (onDispatch: (worker: JournalClient, event: StepDispatchEvent) => void) => {
      const worker = journal.createPeer();
      await worker.connect();
      await worker.hello('retried-agent-worker');
      worker.on('step.dispatch', (event: StepDispatchEvent) => onDispatch(worker, event));
      await worker.workerAttach(`worker-${Math.random()}`, ['agent'],
        { workspace: [], streams: [{ stream, read_offset: 0 }] }, 1);
      return worker;
    };
    let firstDispatched!: () => void;
    const dispatchedToFirst = new Promise<void>(resolve => { firstDispatched = resolve; });
    const first = await attach(() => firstDispatched());
    const outcome = await journal.runStart(spec);
    await dispatchedToFirst;
    const second = await attach((worker, event) => {
      void worker.stepComplete(event.run_id, event.step_id, event.attempt, event.idempotency_key, 'success', {
        output: { stdout_tail: 'second attempt' }, started_pins: event.pins, end_pins: event.pins,
      });
    });
    closes.push(async () => second.close());
    first.close();
    // What `classifyOutcome` does for a parked child: resume it, so the
    // recovered attempt's retry is dispatched to the live worker.
    const deadline = Date.now() + 30_000;
    let status = (await journal.runGet(outcome.run_id)).status;
    while (status !== 'completed') {
      if (Date.now() > deadline) {
        throw new Error(`retried agent run did not complete: ${JSON.stringify(
          (await journal.journalRead(outcome.run_id, 1, 1000)).entries.map(entry => (entry as { entry_type: string }).entry_type))}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      status = (await journal.runResume(outcome.run_id, true)).status;
    }

    const entries = (await journal.journalRead(outcome.run_id, 1, 1000)).entries as Array<{
      entry_type: string; payload?: { completionReason?: string; disposition?: string };
    }>;
    expect(entries.filter(entry => entry.entry_type === 'step.completed')
      .map(entry => [entry.payload?.completionReason, entry.payload?.disposition]))
      .toEqual([['crashed', 'retry'], ['success', 'step_done']]);

    const steps: AuthoredFlowJournalStep[] = [];
    await expect(readCompletedStepOutput(journal, outcome.run_id, 'agent-1', steps))
      .resolves.toEqual({ stdout_tail: 'second attempt' });
    expect(steps.map(step => step.completionReason)).toEqual(['success']);
  }, 60_000);
});
