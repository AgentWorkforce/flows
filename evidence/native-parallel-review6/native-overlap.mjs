import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const base = '/bench/node_modules/@relayflows/sdk/dist/cli.js';
const head = '/bench/sdk-head/dist/cli.js';
const daemon = '/bench/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd';
const samples = { base: [], head: [] };

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function one(side, index) {
  const root = fs.mkdtempSync('/bench/native-overlap-');
  const data = path.join(root, 'data');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync('/bench/node_modules', path.join(root, 'node_modules'));
  const branch = label => `const ${label} = async () => {
    await f.run('date +%s%3N > ${label}-start; sleep 0.3; date +%s%3N > ${label}-end');
    await f.run('date +%s%3N > ${label}-dependent-start; sleep 0.1; date +%s%3N > ${label}-dependent-end');
  };`;
  fs.writeFileSync(path.join(root, 'native.flow.ts'), `import { flow } from '@relayflows/surface';
export default flow('native-overlap', async f => {
  ${['a', 'b', 'c'].map(branch).join('\n')}
  await Promise.all([a(), b(), c()]);
  f.done('success');
});\n`);
  const cli = side === 'head' ? head : base;
  const started = Date.now();
  try {
    const child = spawn(process.execPath, [cli, 'run', '--no-observer-link', '--json', '--data-dir', data,
      path.join(root, 'native.flow.ts'), '--input', '{}'], {
      cwd: root, env: { ...process.env, RELAYFLOWD_BIN: daemon }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const cliMs = Date.now() - started;
    if (result.code !== 0) throw new Error(`${side} run failed: ${output}`);
    const read = name => Number(fs.readFileSync(path.join(root, name), 'utf8').trim());
    const routes = ['a', 'b', 'c'].map(label => ({ start: read(`${label}-start`), end: read(`${label}-end`) }));
    const dependents = ['a', 'b', 'c'].map(label => ({
      start: read(`${label}-dependent-start`), end: read(`${label}-dependent-end`),
    }));
    const routeStartSpreadMs = Math.max(...routes.map(span => span.start)) - Math.min(...routes.map(span => span.start));
    const routeOverlap = Math.max(...routes.map(span => span.start)) < Math.min(...routes.map(span => span.end));
    const dependentOverlap = Math.max(...dependents.map(span => span.start))
      < Math.min(...dependents.map(span => span.end));
    const bodyMs = Math.max(...dependents.map(span => span.end)) - Math.min(...routes.map(span => span.start));
    const sample = { side, index, cliMs, bodyMs, routeStartSpreadMs, routeOverlap, dependentOverlap };
    samples[side].push(sample);
    console.log(JSON.stringify(sample));
  } finally {
    const connection = path.join(data, 'connection.json');
    if (fs.existsSync(connection)) {
      const pid = JSON.parse(fs.readFileSync(connection, 'utf8')).pid;
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (let index = 0; index < 10; index++) {
  await one('base', index);
  await one('head', index);
}
for (const side of ['base', 'head']) {
  const values = samples[side];
  console.log(JSON.stringify({ side, summary: {
    cliP50Ms: percentile(values.map(value => value.cliMs), 0.5),
    cliP95Ms: percentile(values.map(value => value.cliMs), 0.95),
    bodyP50Ms: percentile(values.map(value => value.bodyMs), 0.5),
    routeStartSpreadP50Ms: percentile(values.map(value => value.routeStartSpreadMs), 0.5),
    routeOverlap: values.filter(value => value.routeOverlap).length,
    dependentOverlap: values.filter(value => value.dependentOverlap).length,
  } }));
}
