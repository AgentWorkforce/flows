import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const head = '/bench/sdk-head/dist/cli.js';
const old = '/bench/node_modules/@relayflows/sdk/dist/cli.js';
const daemon = '/bench/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function start(cli, args, root) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root, env: { ...process.env, RELAYFLOWD_BIN: daemon }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  return { child, closed: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))),
    get output() { return output; } };
}

function stopDaemon(data) {
  const connection = path.join(data, 'connection.json');
  if (!fs.existsSync(connection)) return;
  const pid = JSON.parse(fs.readFileSync(connection, 'utf8')).pid;
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function one(index) {
  const root = fs.mkdtempSync('/bench/rollback-');
  const data = path.join(root, 'data');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync('/bench/node_modules', path.join(root, 'node_modules'));
  const flow = path.join(root, 'rollback.flow.ts');
  fs.writeFileSync(flow, `import { flow } from '@relayflows/surface';
export default flow('rollback-parallel', async f => {
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.3; printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.3; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});\n`);
  let initial;
  try {
    initial = start(head, ['run', '--no-observer-link', '--json', '--data-dir', data, flow, '--input', '{}'], root);
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(path.join(root, 'stalled'))) {
      if (initial.child.exitCode !== null || initial.child.signalCode !== null)
        throw new Error(`head run failed before stall: ${initial.output}`);
      if (Date.now() >= deadline) throw new Error(`head stall timeout: ${initial.output}`);
      await sleep(25);
    }
    const before = fs.readFileSync(path.join(root, 'effects'), 'utf8').split('').sort().join('');
    if (before !== 'abc') throw new Error(`head effects before rollback: ${before}`);
    const rootRunId = fs.readdirSync(path.join(data, 'runs')).filter(name => name.endsWith('.sqlite3')).sort()[0].slice(0, -8);
    initial.child.kill('SIGKILL');
    await initial.closed;
    stopDaemon(data);
    fs.writeFileSync(path.join(root, 'release'), '');
    const refused = start(old, ['resume', '--no-observer-link', '--json', '--data-dir', data, rootRunId], root);
    const oldResult = await refused.closed;
    if (oldResult.code === 0) throw new Error(`old CLI resumed parallel root: ${refused.output}`);
    const afterOld = fs.readFileSync(path.join(root, 'effects'), 'utf8').split('').sort().join('');
    if (afterOld !== before) throw new Error(`old CLI replayed effects: ${before} -> ${afterOld}`);
    stopDaemon(data);
    const resumed = start(head, ['resume', '--no-observer-link', '--json', '--data-dir', data, rootRunId], root);
    const newResult = await resumed.closed;
    if (newResult.code !== 0) throw new Error(`head failed to resume after rollback refusal: ${resumed.output}`);
    const after = fs.readFileSync(path.join(root, 'effects'), 'utf8').split('').sort().join('');
    if (after !== 'Zabc') throw new Error(`head replayed effects after rollback refusal: ${after}`);
    console.log(JSON.stringify({ index, oldExit: oldResult.code, oldDiagnostic: refused.output.slice(0, 300),
      before, afterOld, after, resumed: true }));
  } finally {
    if (initial?.child.exitCode === null && initial.child.signalCode === null) initial.child.kill('SIGKILL');
    stopDaemon(data);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (let index = 0; index < 6; index++) await one(index);
console.log(JSON.stringify({ done: true, repetitions: 6 }));
