import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
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
  it('reports an active parallel resume as an environment refusal and a completed one as done', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(`${fixture.root}/noop.cjs`, 'module.exports = 1;\n');
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('completed-parallel-resume', async f => {
  await Promise.all([f.run('printf A >> effects'), f.run('printf B >> effects')]);
  await f.run('test -f release || { touch stalled; sleep 120; }; printf X >> effects', { timeout: '5m' });
  await f.run('printf Z >> effects');
  f.done('success');
});
`);
    const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const cliExited = new Promise<void>(done => cli.once('exit', () => done()));
    await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, 'parallel resume stall');
    const rootRunId = runIds(fixture.data)[0]!;
    cli.kill('SIGKILL');
    await cliExited;
    killDaemon(fixture.data);
    writeFileSync(`${fixture.root}/release`, '');

    const preloadResume = () => spawnSync(process.execPath,
      [resolve('dist/cli.js'), 'resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId],
      { cwd: fixture.root, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, RELAYFLOWD_BIN: fixture.binary,
          NODE_OPTIONS: `--require=${fixture.root}/noop.cjs` } });
    const refused = preloadResume();
    expect(refused.status, refused.stderr + refused.stdout).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      diagnostics: [expect.objectContaining({ severity: 'refusal', kind: 'unsafe_parallel_runtime' })],
    });
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['A', 'B']);

    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['A', 'B', 'X', 'Z']);

    const completed = preloadResume();
    expect(completed.status, completed.stderr + completed.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['A', 'B', 'X', 'Z']);
  }, 150_000);

  it.each(['after a first step', 'with the group first'])(
    'keeps a re-exported body serial %s and reuses completed effects on resume', async (shape) => {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `export { default } from './impl.ts';\n`);
      writeFileSync(`${fixture.root}/impl.ts`, `import { flow } from '@relayflows/surface';
const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };
export default flow('reexported-body', async f => {
  ${shape === 'after a first step' ? "await f.run('printf W >> effects');" : ''}
  await Promise.all([f.run('sleep 0.2; printf A'), f.run('printf B'), f.run('printf C')]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});\n`);
      const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
        fixture.flowPath, '--input', '{}');
      const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
      await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, 're-export stall');
      const rootRunId = runIds(fixture.data)[0]!;
      const reader = new JournalClient(socketPathFor(fixture.data));
      await reader.connect();
      await reader.hello('reexport-serial-test');
      try {
        expect(await readAuthoredRootMetadata(reader, rootRunId))
          .toMatchObject({ executionMode: 'serial' });
      } finally { reader.close(); }
      expect(readFileSync(`${fixture.root}/effects`, 'utf8')).toBe(
        shape === 'after a first step' ? 'WX' : 'X');
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      writeFileSync(`${fixture.root}/release`, '');
      const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
      expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
      expect(readFileSync(`${fixture.root}/effects`, 'utf8')).toBe(
        shape === 'after a first step' ? 'WXZ' : 'XZ');
    }, 120_000);

  it('keeps a flow with an imported Promise.all patch on the serial scheduler', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(`${fixture.root}/patch.mjs`, `const intrinsic = Promise.all;
const timer = setInterval(() => {
  if (Promise.all === intrinsic) return;
  Promise.all = function (values) { return intrinsic.call(Promise, values); };
  clearInterval(timer);
}, 1);\n`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import './patch.mjs';
export default flow('imported-promise-patch', async f => {
  await f.run('sleep 0.2; printf W >> effects');
  await Promise.all([f.run('printf A >> effects'), f.run('printf B >> effects')]);
  await f.run('printf X >> effects');
  f.done('success');
});\n`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort().join('')).toBe('ABWX');
  }, 60_000);

  it('keeps the reviewer imported patch runnable in serial mode', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    mkdirSync(`${fixture.root}/lib`);
    writeFileSync(`${fixture.root}/lib/patch.mjs`, `const I = Function('return this')()['Pro' + 'mise'];
const intrinsicAll = I.all;
const t = setInterval(() => { if (I.all !== intrinsicAll) { clearInterval(t); I.all = function all(xs) { return intrinsicAll.call(I, xs); }; } }, 2);
t.unref();\n`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import './lib/patch.mjs';
export default flow('q6Pw', async f => {
  await f.run('sleep 0.3; printf W');
  const a = async () => { await f.run('sleep 0.4; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');
  await f.run('printf Z >> effects');
  f.done('success');
});\n`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort().join('')).toBe('XZabc');
  }, 60_000);

  it('overlaps two sleep 2 commands started in Promise.all', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const previousEnv = process.env.FLOWS_PARALLEL_TEST_ENV;
    process.env.FLOWS_PARALLEL_TEST_ENV = 'peer-env';
    writeFileSync(`${fixture.root}/span.mjs`, `import { writeFileSync } from 'node:fs';
const name = process.argv[2];
writeFileSync(name + '-start', String(Date.now()));
await new Promise(resolve => setTimeout(resolve, 2000));
writeFileSync(name + '-end', String(Date.now()));
writeFileSync(name + '-env', process.env.FLOWS_PARALLEL_TEST_ENV || 'missing');
process.stdout.write(name + ':' + process.env.FLOWS_PARALLEL_TEST_ENV);
`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('parallel-run', async f => {
  await Promise.all([
    f.run('node span.mjs first'),
    f.run('node span.mjs second'),
  ]);
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
    const firstStart = Number(readFileSync(`${fixture.root}/first-start`, 'utf8'));
    const secondStart = Number(readFileSync(`${fixture.root}/second-start`, 'utf8'));
    const firstEnd = Number(readFileSync(`${fixture.root}/first-end`, 'utf8'));
    const secondEnd = Number(readFileSync(`${fixture.root}/second-end`, 'utf8'));
    const elapsedMs = Math.max(firstEnd, secondEnd) - Math.min(firstStart, secondStart);
    expect(readFileSync(`${fixture.root}/first-env`, 'utf8')).toBe('peer-env');
    expect(readFileSync(`${fixture.root}/second-env`, 'utf8')).toBe('peer-env');
    console.info(`parallel sleep 2 elapsed: ${elapsedMs} ms`);
    expect(elapsedMs).toBeLessThan(3_000);
  }, 60_000);

  it('starts a fast branch dependent before a slow sibling completes', () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(`${fixture.root}/dependent.mjs`, `import { writeFileSync } from 'node:fs';
writeFileSync('dependent-start', String(Date.now()));
process.stdout.write('dependent');
`);
    writeFileSync(`${fixture.root}/slow.mjs`, `import { writeFileSync } from 'node:fs';
writeFileSync('slow-start', String(Date.now()));
await new Promise(resolve => setTimeout(resolve, 3000));
process.stdout.write('slow');
`);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('parallel-dependent', async f => {
  const slow = async () => await f.run('node slow.mjs');
  const fast = async () => {
    await f.run('sleep 1; printf fast');
    return await f.run('node dependent.mjs');
  };
  await Promise.all([slow(), fast()]);
  f.done('success');
});
`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const elapsedMs = Number(readFileSync(`${fixture.root}/dependent-start`, 'utf8'))
      - Number(readFileSync(`${fixture.root}/slow-start`, 'utf8'));
    console.info(`fast dependent started after: ${elapsedMs} ms`);
    expect(elapsedMs).toBeLessThan(2_300);
  }, 60_000);

  it('keeps declaration order when the later child finishes first', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('out-of-order-parallel-run', async f => {
  const outputs = await Promise.all([
    f.run('sleep 2; printf slow'),
    f.run('printf fast'),
  ]);
  await f.run('printf ' + outputs[0] + ':' + outputs[1] + ' > ordered.txt');
  f.done('success');
});
`);
    const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(`${fixture.root}/ordered.txt`, 'utf8')).toBe('slow:fast');
    const rootRunId = runIds(fixture.data)[0]!;
    const reader = new JournalClient(socketPathFor(fixture.data));
    await reader.connect();
    await reader.hello('parallel-order-test');
    try {
      const records = (await reader.streamRead(rootRunId, AUTHORED_STEP_STREAM, 0, 100)).messages
        .map(message => (message as { message?: unknown }).message ?? message) as Array<{
          step?: string; state?: string;
        }>;
      expect(records.filter(record => record.state === 'completed'
        && (record.step === 'run-1' || record.step === 'run-2'))
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
  await Promise.all([
    f.run('node work.mjs 0'), f.run('node work.mjs 1'), f.run('node work.mjs 2'),
    f.run('node work.mjs 3'), f.run('node work.mjs 4'), f.run('node work.mjs 5'),
    f.run('node work.mjs 6'), f.run('node work.mjs 7'), f.run('node work.mjs 8'),
  ]);
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
  await Promise.all([
    f.run('node fail-work.mjs 0'), f.run('node fail-work.mjs 1'), f.run('node fail-work.mjs 2'),
    f.run('node fail-work.mjs 3'), f.run('node fail-work.mjs 4'), f.run('node fail-work.mjs 5'),
    f.run('node fail-work.mjs 6'), f.run('node fail-work.mjs 7'), f.run('touch queued-started'),
  ]);
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
export default flow('parallel-recovery', async f => {
  const outputs = await Promise.all([
    f.run('printf x >> first-count; sleep 1; printf first'),
    f.run('test -f stalled-marker || { touch stalled-marker; sleep 120; }; printf second', { timeout: '5m' }),
  ]);
  await f.run('printf ' + outputs[0] + ':' + outputs[1] + ' > recovered.txt');
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
    expect(readFileSync(`${fixture.root}/recovered.txt`, 'utf8')).toBe('first:second');
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
      expect(runIds(fixture.data)).toHaveLength(5); // root, both children, follow-up, completion marker
    } finally { after.close(); }
  }, 120_000);

  it('replays follow-up steps in parallel branches after a crash', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
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
  await f.run('printf ! >> branch-effects');
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

  it.skipIf(process.env.RELAYFLOWS_PREVIOUS_CLI === undefined)(
    'refuses a parallel v3 root under an older CLI and lets the new CLI resume it', async () => {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('rollback-parallel-root', async f => {
  await Promise.all([f.run('printf A >> effects'), f.run('printf B >> effects')]);
  await f.run('test -f release || { touch stalled; sleep 120; }; printf C >> effects', { timeout: '5m' });
  f.done('success');
});
`);
      const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
        fixture.flowPath, '--input', '{}');
      const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
      await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, 'rollback stall');
      const before = [...readFileSync(`${fixture.root}/effects`, 'utf8')].sort();
      expect(before).toEqual(['A', 'B']);
      const rootRunId = runIds(fixture.data)[0]!;
      const reader = new JournalClient(socketPathFor(fixture.data));
      await reader.connect();
      await reader.hello('rollback-root-kind-test');
      try {
        expect(await readAuthoredRootMetadata(reader, rootRunId))
          .toMatchObject({ kind: 'relayflows.authored-root.parallel.v3', executionMode: 'parallel' });
      } finally { reader.close(); }
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      writeFileSync(`${fixture.root}/release`, '');
      const old = spawnSync(process.execPath, [process.env.RELAYFLOWS_PREVIOUS_CLI!, 'resume',
        '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId],
      { cwd: fixture.root, env: { ...process.env, RELAYFLOWD_BIN: fixture.binary }, encoding: 'utf8', timeout: 30_000 });
      expect(old.status, old.stderr + old.stdout).not.toBe(0);
      expect(old.stderr + old.stdout).toMatch(/malformed authority metadata/u);
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(before);
      const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
      expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['A', 'B', 'C']);
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

  it.each([
    { name: 'closure-shared readiness', expected: ['A', 'B', 'C'], preamble: `
let releaseFirst;
const ready = new Promise(resolve => { releaseFirst = resolve; });`, body: `
  const left = async () => {
    await f.run('printf A >> effects');
    releaseFirst();
    await f.run('printf B >> effects');
  };
  const right = async () => {
    await Promise.all([ready, ready]);
    await f.run('printf C >> effects');
  };
  await Promise.all([left(), right()]);` },
    { name: 'shared completion-order array', expected: ['A', 'B'], preamble: '', body: `
  const out = [];
  const left = async () => { out.push(await f.run('printf A >> effects; printf a')); };
  const right = async () => { out.push(await f.run('printf B >> effects; printf b')); };
  await Promise.all([left(), right()]);
  await f.run('printf ' + out.join('') + ' > order');` },
    { name: 'deep non-step joins with a swallowed refusal', expected: ['A', 'B'], preamble: '', body: `
  const descend = async n => n === 0 ? undefined : Promise.all([descend(n - 1), descend(n - 1)]);
  await Promise.all([descend(12), f.run('printf A >> effects')]);
  try { await f.run('printf B >> effects'); } catch { /* would silently skip B */ }` },
  ])('keeps $name serial and replays no completed effect', async ({ name, expected, preamble, body }) => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';${preamble}
export default flow('serial-review-${name.replaceAll(' ', '-')}', async f => {${body}
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
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(expected);
      const rootRunId = runIds(fixture.data)[0]!;
      const reader = new JournalClient(socketPathFor(fixture.data));
      await reader.connect();
      await reader.hello('serial-review-test');
      try {
        expect(await readAuthoredRootMetadata(reader, rootRunId))
          .toMatchObject({ kind: 'relayflows.authored-root.v1', executionMode: 'serial' });
      } finally { reader.close(); }
      const order = existsSync(`${fixture.root}/order`) ? readFileSync(`${fixture.root}/order`, 'utf8') : undefined;
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      writeFileSync(`${fixture.root}/release`, '');
      const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
      expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual([...expected, 'Z'].sort());
      if (order !== undefined) expect(readFileSync(`${fixture.root}/order`, 'utf8')).toBe(order);
      await fixture.close();
    }
  }, 240_000);

  it('keeps done inside a branch on the established serial scheduler', async () => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-branch-completion', async f => {
  const b = async () => { await f.run('sleep 0.4; printf B >> effects'); await f.run('printf C >> effects'); };
  const a = async () => { await f.run('sleep 0.1; printf A >> effects'); f.done('success'); };
  await Promise.all([b(), a()]);
});
`);
      const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
        fixture.flowPath, '--input', '{}');
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['A', 'B', 'C']);
      await fixture.close();
    }
  }, 120_000);

  it('retains the base failure when a branch completes before its sibling continues', async () => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-early-completion', async f => {
  const a = async () => { await f.run('sleep 0.4; printf A >> effects'); f.done('success'); };
  const b = async () => { await f.run('sleep 0.1; printf B >> effects'); await f.run('printf C >> effects'); };
  await Promise.all([a(), b()]);
});
`);
      const result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
        fixture.flowPath, '--input', '{}');
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/operation_after_completion/u);
      await fixture.close();
    }
  }, 120_000);

  it('keeps an arguments-alias LLM body serial without replay across six resumes', async () => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-hidden-llm', async function (f) {
  const g = arguments[0];
  const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
  const left = async () => { await g.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await g.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
`);
      const cli = fixture.invokeAsync('run', '--no-observer-link', '--json', '--local-agent',
        '--data-dir', fixture.data, fixture.flowPath, '--input', '{}');
      const cliExited = new Promise<void>(resolve => cli.once('exit', () => resolve()));
      closes.push(async () => {
        if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
        await cliExited;
      });
      await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, 'hidden LLM stall', 90_000);
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['L', 'R']);
      expect(fixture.requests()).toHaveLength(2);
      const rootRunId = runIds(fixture.data)[0]!;
      const reader = new JournalClient(socketPathFor(fixture.data));
      await reader.connect();
      await reader.hello('hidden-llm-mode-test');
      try {
        expect(await readAuthoredRootMetadata(reader, rootRunId))
          .toMatchObject({ kind: 'relayflows.authored-root.v1', executionMode: 'serial' });
      } finally { reader.close(); }
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      writeFileSync(`${fixture.root}/release`, '');
      const resumed = spawnSync(process.execPath,
        [resolve('dist/cli.js'), 'resume', '--no-observer-link', '--json', '--local-agent',
          '--data-dir', fixture.data, rootRunId],
        { cwd: fixture.root, encoding: 'utf8', timeout: 90_000,
          env: { ...process.env, RELAYFLOWD_BIN: fixture.binary } });
      // #674: the established serial scheduler can bind a child admission key
      // to a different spec when concurrent branches resume in another order.
      // It is also reproducible on 2.0.50/2.0.51. The mode and replay checks
      // remain required here; the conflict is the only permitted refusal.
      if (resumed.status !== 0) {
        expect(resumed.status).toBe(1);
        expect(resumed.stderr + resumed.stdout).toMatch(/run_admission_conflict/u);
      }
      const effects = [...readFileSync(`${fixture.root}/effects`, 'utf8')];
      expect(effects.every(effect => effect === 'L' || effect === 'R' || effect === 'Z')).toBe(true);
      expect(effects.filter(effect => effect === 'L' || effect === 'R').sort()).toEqual(['L', 'R']);
      const zCount = effects.filter(effect => effect === 'Z').length;
      expect(zCount).toBeLessThanOrEqual(1);
      if (resumed.status === 0) expect(zCount).toBe(1);
      expect(fixture.requests()).toHaveLength(2);
      await fixture.close();
    }
  }, 240_000);

  it.each([
    { name: 'bound module Promise', preamble: `const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };`,
      body: `await Promise.all([f.run('sleep 0.1; printf A'), f.run('printf B'), f.run('printf C')]);
        await f.run('printf X >> effects');`, expected: 'X' },
    { name: 'hand-written module Promise', preamble: `const Promise = { all: values => new globalThis.Promise((resolve, reject) => {
        const items = [...values], results = Array(items.length); let remaining = items.length;
        items.forEach((item, index) => globalThis.Promise.resolve(item).then(value => {
          results[index] = value; if (--remaining === 0) resolve(results);
        }, reject));
      }) };`,
      body: `await Promise.all([f.run('sleep 0.1; printf A'), f.run('printf B'), f.run('printf C')]);
        await f.run('printf X >> effects');`, expected: 'X' },
    { name: 'module Promise class', preamble: `class Promise extends globalThis.Promise {
        static all(values) { return super.all(values); }
      }`,
      body: `await Promise.all([f.run('sleep 0.1; printf A'), f.run('printf B'), f.run('printf C')]);
        await f.run('printf X >> effects');`, expected: 'X' },
    { name: 'module Promise Native branches', preamble: `const Promise = {
        all: globalThis.Promise.all.bind(globalThis.Promise),
      };`,
      body: `const left = async () => { await f.run('sleep 0.1; printf A'); await f.run('printf L >> effects'); };
        const right = async () => { await f.run('printf B'); await f.run('printf R >> effects'); };
        await Promise.all([left(), right()]);`, expected: 'LR' },
    { name: 'imported Bluebird Promise Native branches', preamble: `import Promise from 'bluebird';`,
      body: `const left = async () => { await f.run('sleep 0.1; printf A'); await f.run('printf L >> effects'); };
        const right = async () => { await f.run('printf B'); await f.run('printf R >> effects'); };
        await Promise.all([left(), right()]);`, expected: 'LR' },
    { name: 'empty async branches', preamble: '',
      body: `const warm = async () => {};
        await Promise.all([warm(), warm()]);
        await f.run('printf X >> effects');`, expected: 'X' },
  ])('keeps $name serial without replay across six resumes', async ({ name, preamble, body, expected }) => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
${preamble}
export default flow('serial-module-${name.replaceAll(' ', '-')}', async f => {
  ${body}
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
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort().join('')).toBe(expected);
      const rootRunId = runIds(fixture.data)[0]!;
      const reader = new JournalClient(socketPathFor(fixture.data));
      await reader.connect();
      await reader.hello('module-promise-mode-test');
      try {
        expect(await readAuthoredRootMetadata(reader, rootRunId))
          .toMatchObject({ kind: 'relayflows.authored-root.v1', executionMode: 'serial' });
      } finally { reader.close(); }
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      writeFileSync(`${fixture.root}/release`, '');
      const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
      expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort().join(''))
        .toBe([...expected, 'Z'].sort().join(''));
      await fixture.close();
    }
  }, 240_000);

  it('keeps a Bluebird group of direct f.run calls serial across six resumes', async () => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import Promise from 'bluebird';
export default flow('serial-bluebird-direct', async f => {
  await Promise.all([f.run('printf A >> effects'), f.run('printf B >> effects')]);
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
      await until(() => existsSync(`${fixture.root}/stalled`) ? true : undefined, 'Bluebird direct stall', 60_000);
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['A', 'B']);
      const rootRunId = runIds(fixture.data)[0]!;
      const reader = new JournalClient(socketPathFor(fixture.data));
      await reader.connect();
      await reader.hello('bluebird-direct-mode-test');
      try {
        expect(await readAuthoredRootMetadata(reader, rootRunId))
          .toMatchObject({ kind: 'relayflows.authored-root.v1', executionMode: 'serial' });
      } finally { reader.close(); }
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      writeFileSync(`${fixture.root}/release`, '');
      const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
      expect([0, 1]).toContain(resumed.status);
      if (resumed.status !== 0) expect(resumed.stderr + resumed.stdout).toMatch(/unawaited_step/u);
      const effects = [...readFileSync(`${fixture.root}/effects`, 'utf8')];
      for (const effect of ['A', 'B']) expect(effects.filter(item => item === effect)).toHaveLength(1);
      await fixture.close();
    }
  }, 240_000);

  it.each([
    { name: 'imported timer helper', delay: `const pause = () => sleep(300);`, wait: `
    await Promise.all([pause(), pause()]);` },
    { name: 'for-await timer', delay: `async function* paused() { await sleep(300); yield 1; }`, wait: `
    for await (const value of paused()) { void value; }` },
  ])('does not replay a completed effect after $name reorder', async ({ name, delay, wait }) => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const fixture = chainFixture();
      closes.push(() => fixture.close());
      writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { setTimeout as sleep } from 'node:timers/promises';
export default flow('serial-reorder-${name.replaceAll(' ', '-')}', async f => {
  ${delay}
  const late = async () => { ${wait}
    await f.run('printf L >> effects');
  };
  const fast = async () => {
    await f.run('sleep 0.2; printf A >> effects');
    await f.run('sleep 0.2; printf B >> effects');
    await f.run('printf C >> effects');
  };
  await Promise.all([fast(), late()]);
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
      expect([...readFileSync(`${fixture.root}/effects`, 'utf8')].sort()).toEqual(['A', 'B', 'C', 'L']);
      const rootRunId = runIds(fixture.data)[0]!;
      const reader = new JournalClient(socketPathFor(fixture.data));
      await reader.connect();
      await reader.hello('reorder-mode-test');
      try {
        expect(await readAuthoredRootMetadata(reader, rootRunId))
          .toMatchObject({ kind: 'relayflows.authored-root.v1', executionMode: 'serial' });
      } finally { reader.close(); }
      cli.kill('SIGKILL');
      await cliExited;
      killDaemon(fixture.data);
      writeFileSync(`${fixture.root}/release`, '');
      const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--data-dir', fixture.data, rootRunId);
      expect([0, 1]).toContain(resumed.status);
      const effects = [...readFileSync(`${fixture.root}/effects`, 'utf8')];
      for (const effect of ['A', 'B', 'C', 'L']) expect(effects.filter(item => item === effect)).toHaveLength(1);
      await fixture.close();
    }
  }, 240_000);

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
