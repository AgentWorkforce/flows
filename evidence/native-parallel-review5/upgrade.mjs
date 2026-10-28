import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const oldBin = '/bench/node_modules/@relayflows/sdk/dist/cli.js';
const headBin = '/bench/sdk-head/dist/cli.js';
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
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(bin, args, root, env) {
  const child = spawn(process.execPath, [bin, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  fs.writeFileSync(flow, `import { flow } from '@relayflows/surface';
export default flow('replay-${test.name}', async f => {${test.body}
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});\n`);
  const env = { ...process.env, PATH: `/bench/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: root, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp', RELAYFLOWD_BIN: daemonBin };
  let original;
  try {
    original = start(oldBin, ['run', '--json', '--no-observer-link', '--data-dir', data, flow, '--input', '{}'], root, env);
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(path.join(root, 'stalled'))) {
      if (original.child.exitCode !== null) throw new Error(`${test.name} run exited early: ${original.output}`);
      if (Date.now() > deadline) throw new Error(`${test.name} never reached stall: ${original.output}`);
      await sleep(25);
    }
    const before = fs.readFileSync(path.join(root, 'effects'), 'utf8').split('').sort().join('');
    if (before !== test.expected) throw new Error(`${test.name} before=${before} expected=${test.expected}`);
    const rootRunId = fs.readdirSync(path.join(data, 'runs')).filter(name => name.endsWith('.sqlite3')).sort()[0].slice(0, -8);
    original.child.kill('SIGKILL');
    await original.closed;
    stopDaemon(data);
    fs.writeFileSync(path.join(root, 'release'), '');
    const resumed = start(headBin, ['resume', '--json', '--no-observer-link', '--data-dir', data, rootRunId], root, env);
    const timeout = setTimeout(() => resumed.child.kill('SIGKILL'), 120_000);
    timeout.unref();
    const result = await resumed.closed;
    clearTimeout(timeout);
    if (result.code !== 0) throw new Error(`${test.name} resume failed: ${result.output}`);
    const after = fs.readFileSync(path.join(root, 'effects'), 'utf8').split('').sort().join('');
    if (after !== [...test.expected, 'Z'].sort().join('')) throw new Error(`${test.name} replay: before=${before} after=${after}`);
    console.log(JSON.stringify({ case: test.name, index, rootRunId, before, after, resumed: true }));
  } finally {
    if (original?.child.exitCode === null && original.child.signalCode === null) original.child.kill('SIGKILL');
    stopDaemon(data);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const repetitions = Number(process.env.REPETITIONS ?? '6');
const selected = cases.filter(test => process.env.CASE === undefined || test.name === process.env.CASE);
for (const test of selected) for (let index = 0; index < repetitions; index++) await one(test, index);
console.log(JSON.stringify({ done: true, cases: selected.length, repetitions }));
