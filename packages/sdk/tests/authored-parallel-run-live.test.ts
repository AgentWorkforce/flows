import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHORED_STEP_STREAM } from '../src/authored-step-index.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function runIds(data: string): string[] {
  return readdirSync(`${data}/runs`).filter(name => name.endsWith('.sqlite3'))
    .map(name => name.slice(0, -'.sqlite3'.length)).sort();
}

function killDaemon(data: string): void {
  const { pid } = JSON.parse(readFileSync(`${data}/connection.json`, 'utf8')) as { pid: number };
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

describe('parallel authored deterministic steps', () => {
  it('overlaps two sleep 2 commands started in Promise.all', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const previousEnv = process.env.FLOWS_PARALLEL_TEST_ENV;
    process.env.FLOWS_PARALLEL_TEST_ENV = 'peer-env';
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { writeFileSync } from 'node:fs';
export default flow('parallel-run', async f => {
  const started = Date.now();
  const outputs = await Promise.all([
    f.run('sleep 2; printf first:$FLOWS_PARALLEL_TEST_ENV'),
    f.run('sleep 2; printf second:$FLOWS_PARALLEL_TEST_ENV'),
  ]);
  writeFileSync('result.json', JSON.stringify({ elapsedMs: Date.now() - started, outputs }));
  f.done('success');
});
`);
    let result;
    try {
      result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
        fixture.flowPath, '--input', '{}');
    } finally {
      if (previousEnv === undefined) delete process.env.FLOWS_PARALLEL_TEST_ENV;
      else process.env.FLOWS_PARALLEL_TEST_ENV = previousEnv;
    }
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const measured = JSON.parse(readFileSync(`${fixture.root}/result.json`, 'utf8')) as {
      elapsedMs: number; outputs: string[];
    };
    expect(measured.outputs).toEqual(['first:peer-env', 'second:peer-env']);
    console.info(`parallel sleep 2 elapsed: ${measured.elapsedMs} ms`);
    expect(measured.elapsedMs).toBeLessThan(3_000);
  }, 60_000);

  it('starts a fast branch dependent before a slow sibling completes', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(`${fixture.root}/dependent.mjs`, `import { writeFileSync } from 'node:fs';
writeFileSync('dependent-start.json', JSON.stringify({ elapsedMs: Date.now() - Number(process.argv[2]) }));
process.stdout.write('dependent');
`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('parallel-dependent', async f => {
  const started = Date.now();
  const slow = async () => await f.run('sleep 3; printf slow');
  const fast = async () => {
    await f.run('sleep 1; printf fast');
    return await f.run('node dependent.mjs ' + started);
  };
  await Promise.all([slow(), fast()]);
  f.done('success');
});
`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const { elapsedMs } = JSON.parse(readFileSync(`${fixture.root}/dependent-start.json`, 'utf8')) as { elapsedMs: number };
    console.info(`fast dependent started after: ${elapsedMs} ms`);
    expect(elapsedMs).toBeLessThan(2_300);
  }, 60_000);

  it('keeps declaration order when the later child finishes first', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { writeFileSync } from 'node:fs';
export default flow('out-of-order-parallel-run', async f => {
  const outputs = await Promise.all([
    f.run('sleep 2; printf slow'),
    f.run('printf fast'),
  ]);
  writeFileSync('ordered.json', JSON.stringify(outputs));
  f.done('success');
});
`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(readFileSync(`${fixture.root}/ordered.json`, 'utf8'))).toEqual(['slow', 'fast']);
    const rootRunId = runIds(fixture.data)[0]!;
    const reader = new JournalClient(socketPathFor(fixture.data));
    await reader.connect();
    await reader.hello('parallel-order-test');
    try {
      const records = (await reader.streamRead(rootRunId, AUTHORED_STEP_STREAM, 0, 100)).messages
        .map(message => (message as { message?: unknown }).message ?? message) as Array<{
          step?: string; state?: string;
        }>;
      expect(records.filter(record => record.state === 'completed' && record.step !== 'complete-3')
        .map(record => record.step)).toEqual(['run-2', 'run-1']);
    } finally { reader.close(); }
  }, 60_000);

  it('admits at most eight deterministic children at once', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(`${fixture.root}/work.mjs`, `import { appendFileSync, readFileSync } from 'node:fs';
const id = process.argv[2];
appendFileSync('spans.jsonl', JSON.stringify({ id, edge: 'start', at: Date.now() }) + '\\n');
const deadline = Date.now() + 10000;
while (readFileSync('spans.jsonl', 'utf8').split('\\n').filter(line => line.includes('"edge":"start"')).length < 8) {
  if (Date.now() > deadline) throw new Error('eight deterministic children were not admitted');
  await new Promise(resolve => setTimeout(resolve, 20));
}
await new Promise(resolve => setTimeout(resolve, 500));
appendFileSync('spans.jsonl', JSON.stringify({ id, edge: 'end', at: Date.now() }) + '\\n');
`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('bounded-parallel-run', async f => {
  await Promise.all(Array.from({ length: 9 }, (_, i) => f.run('node work.mjs ' + i)));
  f.done('success');
});
`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const events = readFileSync(`${fixture.root}/spans.jsonl`, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { id: string; edge: 'start' | 'end'; at: number })
      .sort((a, b) => a.at - b.at || (a.edge === 'end' ? -1 : 1));
    expect(events).toHaveLength(18);
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.edge === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(active).toBe(0);
    expect(peak).toBe(8);
  }, 60_000);

  it('does not admit a queued child after a sibling fails', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(`${fixture.root}/fail-work.mjs`, `import { appendFileSync, readFileSync } from 'node:fs';
const id = process.argv[2];
appendFileSync('fail-starts', id + '\\n');
const deadline = Date.now() + 10000;
while (readFileSync('fail-starts', 'utf8').trim().split('\\n').length < 8) {
  if (Date.now() > deadline) throw new Error('eight children were not admitted');
  await new Promise(resolve => setTimeout(resolve, 20));
}
if (id === '0') process.exit(7);
await new Promise(resolve => setTimeout(resolve, 500));
`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('queued-child-cancellation', async f => {
  await Promise.all(Array.from({ length: 9 }, (_, i) => f.run(i === 8
    ? 'touch queued-started' : 'node fail-work.mjs ' + i)));
  f.done('success');
});
`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(readFileSync(`${fixture.root}/fail-starts`, 'utf8').trim().split('\n')).toHaveLength(8);
    expect(existsSync(`${fixture.root}/queued-started`)).toBe(false);
  }, 60_000);

  it('replays a completed peer and resumes an unfinished peer after a crash', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { writeFileSync } from 'node:fs';
export default flow('parallel-recovery', async f => {
  const outputs = await Promise.all([
    f.run('printf x >> first-count; sleep 1; printf first'),
    f.run('test -f stalled-marker || { touch stalled-marker; sleep 120; }; printf second', { timeout: '5m' }),
  ]);
  writeFileSync('recovered.json', JSON.stringify(outputs));
  f.done('success');
});
`);
    const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
    const rootRunId = await until(() => {
      if (!existsSync(`${fixture.data}/runs`)) return undefined;
      return runIds(fixture.data)[0];
    }, 'root admission');
    const reader = new JournalClient(socketPathFor(fixture.data));
    await reader.connect();
    await reader.hello('parallel-recovery-test');
    await until(async () => {
      try {
        await reader.journalRead(rootRunId, 1, 1);
        return true;
      } catch (error) {
        if (error instanceof Error && /no such table: meta/u.test(error.message)) return undefined;
        throw error;
      }
    }, 'root journal initialization');
    let firstChildRunId: string;
    let secondChildRunId: string;
    try {
      firstChildRunId = await until(async () => {
        const page = await reader.streamRead(rootRunId, AUTHORED_STEP_STREAM, 0, 100);
        const record = page.messages.map(message =>
          (message as { message?: unknown }).message ?? message)
          .find(value => (value as { step?: string; state?: string }).step === 'run-1'
            && (value as { state?: string }).state === 'completed') as { runId?: string } | undefined;
        return record?.runId;
      }, 'first child completion');
      await until(() => existsSync(`${fixture.root}/stalled-marker`) ? true : undefined,
        'unfinished peer to start');
      secondChildRunId = await until(async () => {
        for (const runId of runIds(fixture.data).filter(id => id !== rootRunId && id !== firstChildRunId)) {
          const entries = (await reader.journalRead(runId, 1, 100)).entries;
          if (entries.some(entry => (entry as { step_id?: string }).step_id === 'run-2')) return runId;
        }
        return undefined;
      }, 'second child admission');
    } finally { reader.close(); }

    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);

    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(JSON.parse(readFileSync(`${fixture.root}/recovered.json`, 'utf8'))).toEqual(['first', 'second']);
    expect(readFileSync(`${fixture.root}/first-count`, 'utf8')).toBe('x');

    const after = new JournalClient(socketPathFor(fixture.data));
    await after.connect();
    await after.hello('parallel-recovery-after');
    try {
      const records = (await after.streamRead(rootRunId, AUTHORED_STEP_STREAM, 0, 100)).messages
        .map(message => (message as { message?: unknown }).message ?? message) as Array<{
          step?: string; runId?: string; state?: string;
        }>;
      expect(records.find(record => record.step === 'run-1' && record.state === 'completed')?.runId)
        .toBe(firstChildRunId);
      expect(records.find(record => record.step === 'run-2' && record.state === 'completed')?.runId)
        .toBe(secondChildRunId);
      const firstEntries = (await after.journalRead(firstChildRunId, 1, 100)).entries;
      expect(firstEntries.filter(entry => (entry as { entry_type?: string }).entry_type === 'step.completed'))
        .toHaveLength(1);
      expect(runIds(fixture.data)).toHaveLength(4); // root, both children, completion marker
    } finally { after.close(); }
  }, 120_000);

  it('replays follow-up steps in parallel branches after a crash', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { appendFileSync } from 'node:fs';
export default flow('parallel-branch-recovery', async f => {
  const left = async () => {
    await f.run('sleep 2; printf left-initial');
    await f.run('printf L >> branch-effects; printf left-follow');
    await f.run('printf l >> branch-effects; printf left-last');
  };
  const right = async () => {
    await f.run('printf right-initial');
    await f.run('printf R >> branch-effects; printf right-follow');
    await f.run('printf r >> branch-effects; printf right-last');
  };
  await Promise.all([left(), right()]);
  await f.run('test -f branch-stalled || { touch branch-stalled; sleep 120; }; printf resumed');
  appendFileSync('branch-effects', '!');
  f.done('success');
});
`);
    const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
    await until(() => existsSync(`${fixture.root}/branch-stalled`) ? true : undefined, 'branch stall');
    expect([...readFileSync(`${fixture.root}/branch-effects`, 'utf8')].sort()).toEqual(['L', 'R', 'l', 'r']);
    const rootRunId = runIds(fixture.data)[0]!;
    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);
    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/branch-effects`, 'utf8')].sort()).toEqual(['!', 'L', 'R', 'l', 'r']);
  }, 120_000);
});
