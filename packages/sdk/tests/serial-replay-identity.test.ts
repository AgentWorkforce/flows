import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chainFixture } from './flow-chain-fixture.js';

/**
 * Serial step ids are `<kind>-<N>` from one counter assigned in call order.
 * Inside `Promise.all` that order is result-arrival order. Each case forces
 * the original run's order with a fake model that answers "slow" prompts
 * after a delay; the resume replays both completed results from the journal
 * with no delay, so the other branch resolves first and reaches the lower
 * ordinal. These are live: real daemon, real journal, real admission keys.
 */
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function until(read: () => boolean, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

function runIds(data: string): string[] {
  return readdirSync(`${data}/runs`).filter(name => name.endsWith('.sqlite3'))
    .map(name => name.slice(0, -'.sqlite3'.length)).sort();
}

function effects(root: string): string {
  return existsSync(`${root}/effects`) ? readFileSync(`${root}/effects`, 'utf8') : '';
}

function killDaemon(data: string): void {
  const { pid } = JSON.parse(readFileSync(`${data}/connection.json`, 'utf8')) as { pid: number };
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Fake model/agent CLI: an instruction containing "slow" answers after 1.5s;
 * one containing "stall" touches `stalled` and holds until `release` exists,
 * then answers after 1s.
 */
function delayedModel(fixture: ReturnType<typeof chainFixture>): void {
  writeFileSync(fixture.wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  appendFileSync(${JSON.stringify(fixture.calls)}, JSON.stringify(request) + '\\n');
  if (request.instruction.includes('slow')) await new Promise(r => setTimeout(r, 1500));
  if (request.instruction.includes('stall')) {
    writeFileSync(${JSON.stringify(`${fixture.root}/stalled`)}, '');
    while (!existsSync(${JSON.stringify(`${fixture.root}/release`)})) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('{"message":"ok"}');
}
`);
}

interface StallOptions {
  /** Flow header object literal, e.g. `{ use: ['./child.flow.ts'] }`. */
  readonly header?: string;
  /** Files written beside the flow before it runs. */
  readonly files?: Readonly<Record<string, string>>;
  /** Extra flows.json keys. */
  readonly flowsJson?: Readonly<Record<string, unknown>>;
  /** Kill only once this holds for the effects so far (the stall marker must exist too). */
  readonly ready?: (effects: string) => boolean;
  /** The CLI that runs the original attempt; the resume always uses this checkout's. */
  readonly firstCli?: string;
}

async function runStallResume(body: string, options: StallOptions = {}) {
  const fixture = chainFixture();
  closes.push(() => fixture.close());
  delayedModel(fixture);
  for (const [name, text] of Object.entries(options.files ?? {})) writeFileSync(`${fixture.root}/${name}`, text);
  if (options.flowsJson !== undefined) {
    const flowsJson = JSON.parse(readFileSync(`${fixture.root}/flows.json`, 'utf8')) as Record<string, unknown>;
    writeFileSync(`${fixture.root}/flows.json`, JSON.stringify({ ...flowsJson, ...options.flowsJson }));
  }
  // Agents sharing a working directory take turns (worker-cli.ts
  // serializedByDirectory); distinct trees let the two branches overlap.
  for (const tree of ['left', 'right']) mkdirSync(`${fixture.root}/trees/${tree}`, { recursive: true });
  writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-replay-identity'${options.header === undefined ? '' : `, ${options.header}`}, async f => {
  const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
${body}
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
`);
  const runArgs = ['run', '--no-observer-link', '--json', '--local-agent', '--data-dir', fixture.data,
    fixture.flowPath, '--input', '{}'];
  const cli = options.firstCli === undefined ? fixture.invokeAsync(...runArgs)
    : spawn(process.execPath, [options.firstCli, ...runArgs],
      { cwd: fixture.root, stdio: 'pipe', env: { ...process.env, RELAYFLOWD_BIN: fixture.binary } });
  let cliOutput = '';
  cli.stdout?.on('data', chunk => { cliOutput += String(chunk); });
  cli.stderr?.on('data', chunk => { cliOutput += String(chunk); });
  const cliExited = new Promise<void>(r => cli.once('exit', () => r()));
  closes.push(async () => {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
    await cliExited;
  });
  await until(() => {
    if (cli.exitCode !== null) throw new Error(`exited before stall: ${cliOutput}`);
    return existsSync(`${fixture.root}/stalled`) && (options.ready?.(effects(fixture.root)) ?? true);
  }, 'stall');
  const before = effects(fixture.root);
  const callsBefore = fixture.requests().length;
  const rootRunId = runIds(fixture.data)[0]!;
  cli.kill('SIGKILL');
  await cliExited;
  killDaemon(fixture.data);
  writeFileSync(`${fixture.root}/release`, '');
  const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--local-agent',
    '--data-dir', fixture.data, rootRunId);
  return {
    before, callsBefore, resumed, output: resumed.stdout + resumed.stderr,
    after: effects(fixture.root),
    callsAfter: fixture.requests().length,
  };
}

const MISMATCH = /"kind":"serial_replay_order_mismatch"/u;

describe('serial authored step identity under reordered result arrival', () => {
  it('refuses an f.run that reaches the ordinal a completed f.llm holds', async () => {
    // Original: right resolves first, so llm-3 = "right-second", run-4 = L.
    // Resume: left resolves first and asks for run-3, a never-used key.
    const r = await runStallResume(`
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.llm('right-second', { output, model: 'test-model' }); };
  await Promise.all([left(), right()]);`);
    expect(r.before).toBe('L');
    expect(r.callsBefore).toBe(3);
    expect(r.resumed.status, r.output).toBe(1);
    expect(r.output).toMatch(MISMATCH);
    expect(r.output).toMatch(/ordinal 3 is journaled as llm step \\?"llm-3\\?", but this resume reached it with run/u);
    expect(r.after).toBe('L');
    expect(r.callsAfter).toBe(3);
  }, 180_000);

  it('refuses an f.llm that reaches the ordinal a completed f.run holds', async () => {
    // Original: run-3 = R, llm-4 = "left-second". Resume asks for llm-3.
    const r = await runStallResume(`
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.llm('left-second', { output, model: 'test-model' }); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);`);
    expect(r.before).toBe('R');
    expect(r.callsBefore).toBe(3);
    expect(r.resumed.status, r.output).toBe(1);
    expect(r.output).toMatch(MISMATCH);
    expect(r.output).toMatch(/ordinal 3 is journaled as run step \\?"run-3\\?", but this resume reached it with llm/u);
    expect(r.after).toBe('R');
    expect(r.callsAfter).toBe(3);
  }, 180_000);

  it('refuses an f.run that reaches the ordinal a completed f.agent holds', async () => {
    const r = await runStallResume(`
  const left = async () => { await f.agent('left', { task: 'left slow', model: 'test-model', cwd: 'trees/left' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.agent('right', { task: 'right', model: 'test-model', cwd: 'trees/right' }); await f.agent('right2', { task: 'right-second', model: 'test-model', cwd: 'trees/right' }); };
  await Promise.all([left(), right()]);`);
    expect(r.before).toBe('L');
    expect(r.callsBefore).toBe(3);
    expect(r.resumed.status, r.output).toBe(1);
    expect(r.output).toMatch(MISMATCH);
    expect(r.output).toMatch(/ordinal 3 is journaled as agent step \\?"agent-3\\?", but this resume reached it with run/u);
    expect(r.after).toBe('L');
    expect(r.callsAfter).toBe(3);
  }, 180_000);

  // Same-kind swaps never reach the guard: the kernel binds each admission key
  // to its spec, and these specs differ, so the resume is refused there. These
  // pin that the kernel net still holds (they pass with or without the guard).
  it.each([
    { name: 'f.run vs f.run', before: 'RL', body: `
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };` },
    { name: 'f.llm vs f.llm', before: '', body: `
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.llm('left-second', { output, model: 'test-model' }); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.llm('right-second', { output, model: 'test-model' }); };` },
    { name: 'f.agent vs f.agent', before: '', body: `
  const left = async () => { await f.agent('left', { task: 'left slow', model: 'test-model', cwd: 'trees/left' }); await f.agent('left2', { task: 'left-second', model: 'test-model', cwd: 'trees/left' }); };
  const right = async () => { await f.agent('right', { task: 'right', model: 'test-model', cwd: 'trees/right' }); await f.agent('right2', { task: 'right-second', model: 'test-model', cwd: 'trees/right' }); };` },
  ])('refuses a same-kind $name swap with different specs at the kernel', async ({ before, body }) => {
    const r = await runStallResume(`${body}
  await Promise.all([left(), right()]);`);
    expect(r.before).toBe(before);
    expect(r.callsBefore).toBe(before === '' ? 4 : 2);
    expect(r.resumed.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/run_admission_conflict/u);
    expect(r.after).toBe(before);
    expect(r.callsAfter).toBe(r.callsBefore);
  }, 180_000);

  it('resumes in the journaled order unchanged', async () => {
    // Right is the slow one here, so left resolves first in the original run
    // and again on the resume: every id matches its journaled call.
    const r = await runStallResume(`
  const left = async () => { await f.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right slow', { output, model: 'test-model' }); await f.llm('right-second', { output, model: 'test-model' }); };
  await Promise.all([left(), right()]);`);
    expect(r.before).toBe('L');
    expect(r.resumed.status, r.output).toBe(0);
    expect(r.after).toBe('LZ');
    expect(r.callsAfter).toBe(r.callsBefore);
  }, 180_000);

  it('refuses to apply a journaled f.human answer to a different question', async () => {
    // Original: right resolves first and parks on human-3 asking the RIGHT
    // question; it is answered. Resume: left resolves first and reaches
    // human-3 with the LEFT question. The answer is keyed by wait id alone.
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    delayedModel(fixture);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-replay-human', async f => {
  const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); return f.human('Delete the left bucket?', { to: 'khaliq' }); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); return f.human('Ship the right release?', { to: 'khaliq' }); };
  const [deleteLeft] = await Promise.all([left(), right()]);
  if (deleteLeft) await f.run('printf DELETED >> effects');
  f.done('success');
});
`);
    const first = fixture.invoke('run', '--no-observer-link', '--json', '--local-agent', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const rootRunId = runIds(fixture.data)[0]!;
    expect(first.stdout + first.stderr).toMatch(/human-3/u);
    expect(first.stdout + first.stderr).toMatch(/Ship the right release\?/u);
    const answered = fixture.invoke('answer', '--data-dir', fixture.data, rootRunId, 'human-3', 'yes');
    expect(answered.status, answered.stdout + answered.stderr).toBe(0);
    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--local-agent',
      '--data-dir', fixture.data, rootRunId);
    const output = resumed.stdout + resumed.stderr;
    expect(resumed.status, output).toBe(1);
    expect(output).toMatch(MISMATCH);
    expect(output).toMatch(/ordinal 3 is journaled as human step \\?"human-3\\?" asking a different question/u);
    expect(effects(fixture.root)).toBe('');
  }, 180_000);

  it('refuses an f.run that reaches the ordinal a parked f.human holds', async () => {
    // Original: right parks on human-3 before its answer is lowered, so
    // human-3 is not in the step index; left then completes run-4 = L.
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    delayedModel(fixture);
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('serial-replay-parked-human', async f => {
  const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.human('Ship it?', { to: 'khaliq' }); };
  await Promise.all([left(), right()]);
  f.done('success');
});
`);
    const first = fixture.invoke('run', '--no-observer-link', '--json', '--local-agent', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
    const rootRunId = runIds(fixture.data)[0]!;
    expect(first.stdout + first.stderr).toMatch(/human-3/u);
    const before = effects(fixture.root);
    expect(before).toBe('L');
    const answered = fixture.invoke('answer', '--data-dir', fixture.data, rootRunId, 'human-3', 'yes');
    expect(answered.status, answered.stdout + answered.stderr).toBe(0);
    const resumed = fixture.invoke('resume', '--no-observer-link', '--json', '--local-agent',
      '--data-dir', fixture.data, rootRunId);
    const output = resumed.stdout + resumed.stderr;
    expect(resumed.status, output).toBe(1);
    expect(output).toMatch(MISMATCH);
    expect(output).toMatch(/ordinal 3 is journaled as human step \\?"human-3\\?", but this resume reached it with run/u);
    expect(effects(fixture.root)).toBe(before);
  }, 180_000);

  it('refuses an f.run that reaches the ordinal of an unfinished f.dispatch', async () => {
    // Original: right's dispatch-3 child writes C and stalls in an f.llm
    // before its receipt is journaled; left completes run-4 = L.
    const r = await runStallResume(`
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.dispatch('child', {}); };
  await Promise.all([left(), right()]);`, {
      header: "{ use: ['./child.flow.ts'] }",
      files: { 'child.flow.ts': `import { flow } from '@relayflows/surface';
export default flow('child', async f => {
  await f.run('printf C >> effects');
  await f.llm('child stall', { output: { type: 'object' }, model: 'test-model' });
  f.done('success');
});
` },
      ready: done => done.includes('L'),
    });
    expect([...r.before].sort().join('')).toBe('CL');
    expect(r.resumed.status, r.output).toBe(1);
    expect(r.output).toMatch(MISMATCH);
    expect(r.output).toMatch(/ordinal 3 is journaled as dispatch step \\?"dispatch-3--run-1\\?", but this resume reached it with run/u);
    expect([...r.after].sort().join('')).toBe('CL');
  }, 180_000);

  it('refuses an f.run that reaches the ordinal a completed f.mcp call holds', async () => {
    const log = `${process.env.TMPDIR ?? '.'}/mcp-calls-${process.pid}-${Date.now()}`;
    const r = await runStallResume(`
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.mcp.foo.echo({ n: 1 }); };
  await Promise.all([left(), right()]);`, {
      header: "{ tools: { mcp: ['foo'] } }",
      flowsJson: { mcp: { foo: { command: process.execPath, args: [resolve('../../testdata/mock-mcp-server/ok.mjs'), '', log] } } },
    });
    const toolCalls = () => readFileSync(log, 'utf8').trim().split('\n')
      .filter(line => JSON.parse(line).method === 'tools/call').length;
    expect(r.before).toBe('L');
    expect(toolCalls()).toBe(1);
    expect(r.resumed.status, r.output).toBe(1);
    expect(r.output).toMatch(MISMATCH);
    expect(r.output).toMatch(/ordinal 3 is journaled as mcp step \\?"mcp-3\\?", but this resume reached it with run/u);
    expect(r.after).toBe('L');
    expect(toolCalls()).toBe(1);
  }, 180_000);

  it('stops a running dispatched child when its parent refuses the replay', async () => {
    // dispatch-3's child is mid-run on the resume (its f.llm is recovering)
    // when the parent refuses run-4; the child's next step must not run.
    const r = await runStallResume(`
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.llm('right-second', { output, model: 'test-model' }); };
  await Promise.all([left(), right(), f.dispatch('child', {})]);`, {
      header: "{ use: ['./child.flow.ts'] }",
      files: { 'child.flow.ts': `import { flow } from '@relayflows/surface';
export default flow('child', async f => {
  await f.run('printf C >> effects');
  await f.llm('child stall', { output: { type: 'object' }, model: 'test-model' });
  await f.run('printf D >> effects');
  f.done('success');
});
` },
      ready: done => done.includes('L'),
    });
    expect([...r.before].sort().join('')).toBe('CL');
    expect(r.resumed.status, r.output).toBe(1);
    expect(r.output).toMatch(/ordinal 4 is journaled as llm step \\?"llm-4\\?", but this resume reached it with run/u);
    expect([...r.after].sort().join('')).toBe('CL');
  }, 180_000);

  // Roots journaled by the previous release resume under this guard: the
  // index and wait records it reads are the ones 2.0.55 already writes.
  it.skipIf(process.env.RELAYFLOWS_PREVIOUS_CLI === undefined)(
    'resumes a previous-release serial root in order and refuses it reordered', async () => {
      const firstCli = process.env.RELAYFLOWS_PREVIOUS_CLI!;
      const inOrder = await runStallResume(`
  const left = async () => { await f.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right slow', { output, model: 'test-model' }); await f.llm('right-second', { output, model: 'test-model' }); };
  await Promise.all([left(), right()]);`, { firstCli });
      expect(inOrder.resumed.status, inOrder.output).toBe(0);
      expect(inOrder.after).toBe('LZ');
      const reordered = await runStallResume(`
  const left = async () => { await f.llm('left slow', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.llm('right-second', { output, model: 'test-model' }); };
  await Promise.all([left(), right()]);`, { firstCli });
      expect(reordered.resumed.status, reordered.output).toBe(1);
      expect(reordered.output).toMatch(MISMATCH);
      expect(reordered.after).toBe('L');
      expect(reordered.callsAfter).toBe(3);
    }, 240_000,
  );
});
