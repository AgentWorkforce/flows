import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const bin = '/bench/node_modules/.bin/flows';
const daemonBin = '/bench/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd';
const cases = [
  { name: 'A1', expected: 'LR', body: `
    const left = async () => {
      await Promise.all([f.run('sleep 0.3; printf A'), f.run('printf B')]);
      await f.run('printf L >> effects');
    };
    const right = async () => {
      await Promise.all([f.run('printf C'), f.run('sleep 0.3; printf D')]);
      await f.run('printf R >> effects');
    };
    await Promise.all([left(), right()]);` },
  { name: 'B1', expected: 'LR', body: `
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
  { name: 'N2', expected: 'abc', body: `
    const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
    const b = async () => { await f.run('sleep 0.3; printf B'); await f.run('printf b >> effects'); };
    const c = async () => { await f.run('sleep 0.3; printf C'); await f.run('printf c >> effects'); };
    await Promise.all([a(), b(), c()]);` },
  { name: 'C1e', expected: 'XY', body: `
    const background = (async () => { await f.run('printf X >> effects'); })();
    await new Promise(resolve => setTimeout(resolve, 300));
    await f.run('printf Y >> effects');
    await background;` },
  { name: 'G1', expected: 'ABG', body: `
    await Promise.race([f.run('printf A >> effects'), f.run('sleep 0.3; printf B >> effects')]);
    await f.run('printf G >> effects');` },
  { name: 'ANY', expected: 'ABG', body: `
    await Promise.any([f.run('printf A >> effects'), f.run('sleep 0.3; printf B >> effects')]);
    await f.run('printf G >> effects');` },
  { name: 'I1', expected: 'LRxy', header: `, { use: ['./child.flow.ts'] }`,
    childSource: `import { flow } from '@relayflows/surface';
export default flow('child', async (f, input) => {
  await Promise.all([f.run('printf first'), f.run('printf second')]);
  await f.run('printf ' + input.token + ' >> effects');
  f.done('success');
});\n`, body: `
    const left = async () => { await f.dispatch('child', { token: 'x' }); await f.run('printf L >> effects'); };
    const right = async () => { await f.dispatch('child', { token: 'y' }); await f.run('printf R >> effects'); };
    await Promise.all([left(), right()]);` },
  { name: 'H1', expected: 'LR', wrapperCalls: 2, body: `
    const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
    const left = async () => { await f.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
    const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };
    await Promise.all([left(), right()]);` },
  { name: 'K4', expected: 'LR', wrapperCalls: 2, functionExpression: true, body: `
    const g = arguments[0];
    const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
    const left = async () => { await g.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
    const right = async () => { await g.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };
    await Promise.all([left(), right()]);` },
  { name: 'H2', expected: 'LR', wrapperCalls: 2, body: `
    const left = async () => { await f.agent('left', { task: 'left', model: 'test-model' }); await f.run('printf L >> effects'); };
    const right = async () => { await f.agent('right', { task: 'right', model: 'test-model' }); await f.run('printf R >> effects'); };
    await Promise.all([left(), right()]);` },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(args, root, env) {
  const child = spawn(bin, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output })));
  return { child, closed, get output() { return output; } };
}
function stopDaemon(data) {
  const connection = path.join(data, 'connection.json');
  if (!fs.existsSync(connection)) return;
  const pid = JSON.parse(fs.readFileSync(connection, 'utf8')).pid;
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function one(test, index) {
  const root = fs.mkdtempSync('/bench/replay-verify-');
  const data = path.join(root, 'data');
  const flow = path.join(root, 'test.flow.ts');
  if (test.childSource) fs.writeFileSync(path.join(root, 'child.flow.ts'), test.childSource);
  if (test.wrapperCalls) {
    fs.writeFileSync(path.join(root, 'adapter.mjs'), `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
if (process.argv[2] === '--relayflows-adapter-v1') {
  process.stdout.write('relayflows-agent-cli-v1\\n');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (input.trim() === '') process.exit(0);
  const request = JSON.parse(input);
  if (request.protocol !== 'relayflows-agent-cli-v1') process.exit(2);
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  fs.appendFileSync('calls', 'x');
  process.stdout.write('{"message":"ok"}');
}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'flows.json'), JSON.stringify({ cli: path.join(root, 'adapter.mjs'), models: ['test-model'] }));
  }
  fs.writeFileSync(flow, `import { flow } from '@relayflows/surface';
export default flow('replay-${test.name}'${test.header ?? ''}, ${test.functionExpression ? 'async function(f)' : 'async f =>'} {${test.body}
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});\n`);
  const env = { ...process.env, PATH: `/bench/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: root, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp', RELAYFLOWD_BIN: daemonBin };
  let original;
  try {
    original = start(['run', '--json', '--no-observer-link', ...(test.wrapperCalls ? ['--local-agent'] : []),
      '--data-dir', data, flow, '--input', '{}'], root, env);
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(path.join(root, 'stalled'))) {
      if (original.child.exitCode !== null) throw new Error(`${test.name} run exited early: ${original.output}`);
      if (Date.now() > deadline) throw new Error(`${test.name} never reached stall: ${original.output}`);
      await sleep(25);
    }
    const before = fs.readFileSync(path.join(root, 'effects'), 'utf8').split('').sort().join('');
    if (before !== test.expected) throw new Error(`${test.name} before=${before} expected=${test.expected}`);
    if (test.wrapperCalls && fs.readFileSync(path.join(root, 'calls'), 'utf8').length !== test.wrapperCalls)
      throw new Error(`${test.name} wrapper call count before resume was not ${test.wrapperCalls}`);
    const rootRunId = fs.readdirSync(path.join(data, 'runs')).filter(name => name.endsWith('.sqlite3')).sort()[0].slice(0, -8);
    original.child.kill('SIGKILL');
    await original.closed;
    stopDaemon(data);
    fs.writeFileSync(path.join(root, 'release'), '');
    const resumed = start(['resume', '--json', '--no-observer-link', ...(test.wrapperCalls ? ['--local-agent'] : []),
      '--data-dir', data, rootRunId], root, env);
    const timeout = setTimeout(() => resumed.child.kill('SIGKILL'), 120_000);
    timeout.unref();
    const result = await resumed.closed;
    clearTimeout(timeout);
    if (result.code !== 0) throw new Error(`${test.name} resume failed: ${result.output}`);
    const after = fs.readFileSync(path.join(root, 'effects'), 'utf8').split('').sort().join('');
    if (after !== [...test.expected, 'Z'].sort().join('')) throw new Error(`${test.name} replay: before=${before} after=${after}`);
    if (test.wrapperCalls && fs.readFileSync(path.join(root, 'calls'), 'utf8').length !== test.wrapperCalls)
      throw new Error(`${test.name} replayed an LLM or agent call`);
    console.log(JSON.stringify({ case: test.name, index, rootRunId, before, after, resumed: true }));
  } finally {
    if (original?.child.exitCode === null && original.child.signalCode === null) original.child.kill('SIGKILL');
    stopDaemon(data);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const repetitions = Number(process.env.REPETITIONS ?? '6');
const selection = process.env.CASE?.split(',');
const selected = cases.filter(test => selection === undefined || selection.includes(test.name));
for (const test of selected) for (let index = 0; index < repetitions; index++) await one(test, index);
console.log(JSON.stringify({ done: true, cases: selected.length, repetitions }));
