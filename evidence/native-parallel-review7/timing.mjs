import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const head = '/bench/node_modules/@relayflows/sdk/dist/cli.js';
const base = '/bench/sdk-base-2051/dist/cli.js';
const daemon = '/bench/relayflowd';
const source = `import { flow } from '@relayflows/surface';
export default flow('native-timing', async f => {
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('sleep 0.1; printf a'); };
  const b = async () => { await f.run('sleep 0.3; printf B'); await f.run('sleep 0.1; printf b'); };
  const c = async () => { await f.run('sleep 0.3; printf C'); await f.run('sleep 0.1; printf c'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf Z');
  f.done('success');
});
`;
const sql = `import sqlite3,json,sys,glob,os
out=[]
for file in glob.glob(sys.argv[1]+'/runs/*.sqlite3'):
 c=sqlite3.connect(file)
 rows=c.execute("select entry_type,at_ms,payload from entries where entry_type in ('run.spawned','step.attempt.started','step.completed') order by seq").fetchall()
 spawn=next((json.loads(p) for t,_,p in rows if t=='run.spawned'),None)
 spec=spawn.get('spec') if spawn else None
 step=(spec or {}).get('steps',[{}])[0]
 if not step.get('command'): continue
 starts=[at for t,at,_ in rows if t=='step.attempt.started']
 dones=[at for t,at,_ in rows if t=='step.completed']
 if starts and dones: out.append({'command':step['command'],'start':starts[0],'done':dones[-1]})
print(json.dumps(out))`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(kind, number) {
  const root = fs.mkdtempSync(`/bench/timing-${kind}-${number}-`);
  const data = path.join(root, 'data');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync('/bench/node_modules', path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'chain.flow.ts'), source);
  const binary = kind === 'base' ? base : head;
  const start = performance.now();
  const child = spawn(process.execPath, [binary, 'run', '--no-observer-link', '--json',
    '--data-dir', data, path.join(root, 'chain.flow.ts'), '--input', '{}'], {
    cwd: root, env: { ...process.env, RELAYFLOWD_BIN: daemon }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const cliMs = performance.now() - start;
  try {
    if (result.code !== 0) throw new Error(`${kind} run failed: ${output}`);
    const rows = JSON.parse(execFileSync('python3', ['-c', sql, data], { encoding: 'utf8' }));
    const route = rows.filter(row => /^sleep 0\.3; printf [ABC]$/u.test(row.command));
    const dependent = rows.filter(row => /^sleep 0\.1; printf [abc]$/u.test(row.command));
    if (route.length !== 3 || dependent.length !== 3) throw new Error(`missing timing steps: ${JSON.stringify(rows)}`);
    const routesOverlap = Math.max(...route.map(row => row.start)) < Math.min(...route.map(row => row.done));
    const dependentsOverlap = Math.max(...dependent.map(row => row.start)) < Math.min(...dependent.map(row => row.done));
    return { kind, number, cliMs, bodyMs: Math.max(...dependent.map(row => row.done))
      - Math.min(...route.map(row => row.start)), routeSpreadMs: Math.max(...route.map(row => row.start))
      - Math.min(...route.map(row => row.start)), routesOverlap, dependentsOverlap };
  } finally {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(data, 'connection.json'), 'utf8'));
      process.kill(pid, 'SIGKILL');
    } catch { /* The daemon may already have exited. */ }
    await sleep(30);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const results = [];
await run('base', -1);
await run('head', -1);
for (let number = 0; number < 10; number++) {
  const order = number % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
  for (const kind of order) {
    const result = await run(kind, number);
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
const percentile = (values, p) => {
  const ordered = values.toSorted((a, b) => a - b);
  return ordered[Math.ceil(p * ordered.length) - 1];
};
for (const kind of ['base', 'head']) {
  const set = results.filter(result => result.kind === kind);
  console.log(JSON.stringify({ summary: kind, samples: set.length,
    cliP50Ms: percentile(set.map(result => result.cliMs), 0.5),
    cliP95Ms: percentile(set.map(result => result.cliMs), 0.95),
    bodyP50Ms: percentile(set.map(result => result.bodyMs), 0.5),
    bodyP95Ms: percentile(set.map(result => result.bodyMs), 0.95),
    routeSpreadP50Ms: percentile(set.map(result => result.routeSpreadMs), 0.5),
    routesOverlap: set.filter(result => result.routesOverlap).length,
    dependentsOverlap: set.filter(result => result.dependentsOverlap).length }));
}
