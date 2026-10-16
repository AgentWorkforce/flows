import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHORED_STEP_STREAM } from '../src/authored-step-index.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { chainFixture } from './flow-chain-fixture.js';
import { readAuthoredRootMetadata } from '../src/authored-root.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string,
  timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
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

  it.each([
    {
      name: 'two branches that each join two runs',
      branches: `
  const left = async () => {
    await Promise.all([f.run('sleep 1; printf left-a'), f.run('printf left-b')]);
    await f.run('printf L >> effects; printf left-effect');
  };
  const right = async () => {
    await Promise.all([f.run('printf right-a'), f.run('sleep 1; printf right-b')]);
    await f.run('printf R >> effects; printf right-effect');
  };`,
    },
    {
      name: 'a chain beside a branch with a join',
      branches: `
  const left = async () => {
    await f.run('sleep 1; printf left-a');
    await f.run('printf left-b');
    await f.run('printf L >> effects; printf left-effect');
  };
  const right = async () => {
    await Promise.all([f.run('printf right-a'), f.run('sleep 1; printf right-b')]);
    await f.run('printf R >> effects; printf right-effect');
  };`,
    },
  ])('does not replay a completed effect after a crash: $name', async ({ branches }) => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('parallel-join-recovery', async f => {${branches}
  await Promise.all([left(), right()]);
  await f.run('test -f stalled || { touch stalled; sleep 120; }; printf resumed', { timeout: '5m' });
  f.done('success');
});
`);
    const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
    await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, 'join recovery stall');
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['L', 'R']);
    const rootRunId = runIds(fixture.data)[0]!;
    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);
    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['L', 'R']);
  }, 120_000);

  it.skipIf(process.env.RELAYFLOWS_PREVIOUS_CLI === undefined)(
    'resumes a sequential 2.0.50 run without replaying completed effects', async () => {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('legacy-sequential-resume', async f => {
  await f.run('printf A >> effects');
  await f.run('printf B >> effects');
  await f.run('test -f stalled || { touch stalled; sleep 120; }; printf ready', { timeout: '5m' });
  await f.run('printf D >> effects');
  f.done('success');
});
`);
      const cli = spawn(process.execPath, [process.env.RELAYFLOWS_PREVIOUS_CLI!, 'run',
        '--no-observer-link', '--json', '--data-dir', fixture.data, fixture.flowPath, '--input', '{}'],
      { cwd: fixture.root, stdio: 'pipe', env: { ...process.env, RELAYFLOWD_BIN: fixture.binary } });
      const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
      await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, 'legacy run stall');
      expect(readFileSync(`${fixture.root}/effects`, 'utf8')).toBe('AB');
      const rootRunId = runIds(fixture.data)[0]!;
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
      expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
      expect(readFileSync(`${fixture.root}/effects`, 'utf8')).toBe('ABD');
    }, 120_000,
  );

  it.each([
    { name: 'race', before: ['A', 'B', 'G'], body: `
  await Promise.race([f.run('printf A >> effects'), f.run('sleep 1; printf B >> effects')]);
  await f.run('printf G >> effects');` },
    { name: 'any', before: ['A', 'B', 'G'], body: `
  await Promise.any([f.run('printf A >> effects'), f.run('sleep 1; printf B >> effects')]);
  await f.run('printf G >> effects');` },
    { name: 'eager', before: ['X', 'Y'], body: `
  const background = (async () => { await f.run('printf X >> effects'); })();
  await new Promise(resolve => setTimeout(resolve, 300));
  await f.run('printf Y >> effects');
  await background;` },
  ])('keeps a $name flow running on serial fallback without replay', async ({ name, before, body }) => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-${name}', async f => {${body}
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
`);
    const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
    closes.push(async () => {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
      await cliExited;
    });
    await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, `${name} stall`, 60_000);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(before);
    const rootRunId = runIds(fixture.data)[0]!;
    const reader = new JournalClient(socketPathFor(fixture.data));
    await reader.connect();
    await reader.hello('serial-fallback-test');
    try {
      expect(await readAuthoredRootMetadata(reader, rootRunId))
        .toMatchObject({ identityVersion: 2, executionMode: 'serial' });
    } finally { reader.close(); }
    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);
    writeFileSync(`${fixture.root}/release`, '');
    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual([...before, 'Z'].sort());
  }, 120_000);

  it.each([
    { name: 'llm', localAgent: true, calls: 2, expected: ['L', 'R'], child: undefined, body: `
  const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
  const left = async () => { await f.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);` },
    { name: 'agent', localAgent: true, calls: 2, expected: ['L', 'R'], child: undefined, body: `
  const left = async () => { await f.agent('left', { task: 'left', model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.agent('right', { task: 'right', model: 'test-model' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);` },
    { name: 'dispatch', localAgent: false, calls: 0, expected: ['L', 'R', 'x', 'y'],
      child: `import { flow } from '@relayflows/surface';
export default flow('child', async (f, input: { token: string }) => {
  await Promise.all([f.run('printf first'), f.run('printf second')]);
  await f.run('printf ' + input.token + ' >> effects');
  f.done('success');
});
`, body: `
  const left = async () => { await f.dispatch('child', { token: 'x' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.dispatch('child', { token: 'y' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);` },
  ])('resumes $name branches without replaying completed effects', async ({ name, localAgent, calls, expected, child, body }) => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    if (child !== undefined) writeFileSync(`${fixture.root}/child.flow.ts`, child);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-${name}'${child === undefined ? '' : ", { use: ['./child.flow.ts'] }"}, async f => {${body}
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
`);
    const flags = localAgent ? ['--local-agent'] : [];
    const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', ...flags, '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    let cliOutput = '';
    cli.stdout?.on('data', chunk => { cliOutput += String(chunk); });
    cli.stderr?.on('data', chunk => { cliOutput += String(chunk); });
    const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
    closes.push(async () => {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
      await cliExited;
    });
    await until(() => {
      if (cli.exitCode !== null) throw new Error(`${name} exited before stall: ${cliOutput}`);
      return existsSync(`${fixture.root}/stalled`) ? true : undefined;
    }, `${name} stall`, 90_000);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(expected);
    if (calls > 0) expect(fixture.requests()).toHaveLength(calls);
    const rootRunId = runIds(fixture.data)[0]!;
    const reader = new JournalClient(socketPathFor(fixture.data));
    await reader.connect();
    await reader.hello('mixed-branch-fallback-test');
    try {
      expect(await readAuthoredRootMetadata(reader, rootRunId))
        .toMatchObject({ identityVersion: 2, executionMode: 'serial' });
    } finally { reader.close(); }
    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);
    writeFileSync(`${fixture.root}/release`, '');
    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', ...flags,
      '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual([...expected, 'Z'].sort());
    if (calls > 0) expect(fixture.requests()).toHaveLength(calls);
  }, 180_000);

  for (const pause of ['after run-4', 'after run-5'] as const) {
    it.skipIf(process.env.RELAYFLOWS_PREVIOUS_CLI === undefined)(
      `resumes 2.0.50 consecutive Promise.all groups ${pause} without replay`, async () => {
        const fixture = chainFixture();
        closes.push(() => fixture.close());
        writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { existsSync, writeFileSync } from 'node:fs';
export default flow('legacy-consecutive-groups', async f => {
  await f.run('printf 1 >> effects');
  await f.run('printf 2 >> effects');
  await Promise.all([f.run('printf 3 >> effects'), f.run('printf 4 >> effects')]);
  if (!existsSync('release4')) {
    writeFileSync('pause4', '');
    await new Promise(resolve => setTimeout(resolve, 120000));
  }
  await Promise.all([
    f.run('printf 5 >> effects'),
    f.run('test -f release6 || { touch pause5; sleep 120; }; printf 6 >> effects', { timeout: '5m' }),
  ]);
  f.done('success');
});
`);
        if (pause === 'after run-5') writeFileSync(`${fixture.root}/release4`, '');
        else writeFileSync(`${fixture.root}/release6`, '');
        const cli = spawn(process.execPath, [process.env.RELAYFLOWS_PREVIOUS_CLI!, 'run',
          '--no-observer-link', '--json', '--data-dir', fixture.data, fixture.flowPath, '--input', '{}'],
        { cwd: fixture.root, stdio: 'pipe', env: { ...process.env, RELAYFLOWD_BIN: fixture.binary } });
        let cliOutput = '';
        cli.stdout?.on('data', chunk => { cliOutput += String(chunk); });
        cli.stderr?.on('data', chunk => { cliOutput += String(chunk); });
        const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
        closes.push(async () => {
          if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
          await cliExited;
        });
        try {
          await until(() => {
            if (cli.exitCode !== null) throw new Error(`legacy CLI exited ${cli.exitCode}: ${cliOutput}`);
            return existsSync(`${fixture.root}/${pause === 'after run-4' ? 'pause4' : 'pause5'}`)
              ? true : undefined;
          }, `${pause} marker`, 120_000);
        } catch (error) {
          throw new Error(`${String(error)}; effects=${existsSync(`${fixture.root}/effects`)
            ? readFileSync(`${fixture.root}/effects`, 'utf8') : 'missing'}; cli=${cliOutput}`);
        }
        const rootRunId = runIds(fixture.data)[0]!;
        if (pause === 'after run-5') {
          const reader = new JournalClient(socketPathFor(fixture.data));
          await reader.connect();
          await reader.hello('legacy-group-recovery-test');
          try {
            await until(async () => {
              for (const runId of runIds(fixture.data).filter(id => id !== rootRunId)) {
                try {
                  const entries = (await reader.journalRead(runId, 1, 100)).entries;
                  if (entries.some(entry => (entry as { entry_type?: string; step_id?: string }).entry_type
                    === 'step.completed' && (entry as { step_id?: string }).step_id === 'run-5')) return true;
                } catch (error) {
                  if (error instanceof Error && /no such table: meta/u.test(error.message)) continue;
                  throw error;
                }
              }
              return undefined;
            }, 'legacy run-5 child completion', 60_000);
          } finally { reader.close(); }
        }
        expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort())
          .toEqual(pause === 'after run-4' ? ['1', '2', '3', '4'] : ['1', '2', '3', '4', '5']);
        cli.kill('SIGKILL');
        await cliExited;
        killDaemon(fixture.data);
        writeFileSync(`${fixture.root}/${pause === 'after run-4' ? 'release4' : 'release6'}`, '');
        const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
        expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
        expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort())
          .toEqual(['1', '2', '3', '4', '5', '6']);
      }, 240_000,
    );
  }

  const legacyUpgradeCases = [
    { name: 'A1 nested joins', effects: ['L', 'R'], body: `
  const left = async () => {
    await Promise.all([f.run('sleep 0.3; printf A'), f.run('printf B')]);
    await f.run('printf L >> effects');
  };
  const right = async () => {
    await Promise.all([f.run('printf C'), f.run('sleep 0.3; printf D')]);
    await f.run('printf R >> effects');
  };
  await Promise.all([left(), right()]);` },
    { name: 'B1 chain beside join', effects: ['L', 'R'], body: `
  const left = async () => {
    await f.run('printf A');
    await f.run('printf B');
    await f.run('printf L >> effects');
  };
  const right = async () => {
    await Promise.all([f.run('printf C'), f.run('printf D')]);
    await f.run('printf R >> effects');
  };
  await Promise.all([left(), right()]);` },
    { name: 'N2 independent dependents', effects: ['a', 'b', 'c'], body: `
  const a = async () => { await f.run('printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);` },
  ] as const;
  for (const { name, effects, body } of legacyUpgradeCases) {
    it.skipIf(process.env.RELAYFLOWS_PREVIOUS_CLI === undefined)(
      `resumes 2.0.50 ${name} without replay`, async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('legacy-${name.replaceAll(' ', '-')}', async f => {${body}
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
`);
    const cli = spawn(process.execPath, [process.env.RELAYFLOWS_PREVIOUS_CLI, 'run',
      '--no-observer-link', '--json', '--data-dir', fixture.data, fixture.flowPath, '--input', '{}'],
    { cwd: fixture.root, stdio: 'pipe', env: { ...process.env, RELAYFLOWD_BIN: fixture.binary } });
    let cliOutput = '';
    cli.stdout?.on('data', chunk => { cliOutput += String(chunk); });
    cli.stderr?.on('data', chunk => { cliOutput += String(chunk); });
    const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
    closes.push(async () => {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
      await cliExited;
    });
    await until(() => {
      if (cli.exitCode !== null) throw new Error(`${name} old CLI exited before stall: ${cliOutput}`);
      return existsSync(`${fixture.root}/stalled`) ? true : undefined;
    }, `${name} legacy stall`, 120_000);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(effects);
    const rootRunId = runIds(fixture.data)[0]!;
    const reader = new JournalClient(socketPathFor(fixture.data));
    await reader.connect();
    await reader.hello('legacy-parallel-upgrade-test');
    try {
      const metadata = await readAuthoredRootMetadata(reader, rootRunId);
      expect(metadata?.identityVersion).toBeUndefined();
      expect(metadata?.executionMode).toBeUndefined();
    } finally { reader.close(); }
    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);
    writeFileSync(`${fixture.root}/release`, '');
    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual([...effects, 'Z'].sort());
      }, 240_000,
    );
  }
});
