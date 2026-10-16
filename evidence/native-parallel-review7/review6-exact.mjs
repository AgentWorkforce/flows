import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import scenarios from './s2.mjs';
import baseScenarios from './s.mjs';
import { SURF, NAT, W2, TAIL5 } from './s.mjs';

// Review 6 reported R5n's entry shape and exact patch module, but its
// generator block was not preserved. Reconstruct the entry from the report.
const r5n = { name: 'R5n', files: {
  'chain.flow.ts': `${SURF}\nimport './lib/p.mjs';\nexport default flow('r5n', async f => {\n${W2}${NAT}${TAIL5}`,
  'lib/p.mjs': String.raw`const I = Function('return this')()['Pro' + 'mise'];
const resolve = I.resolve;
let gate;
I.resolve = function (x) {
  if (this !== I || !(x instanceof I) || !/at (Promise|Function)\.all /.test(new Error().stack)) return resolve.call(this, x);
  if (gate === undefined) { let open; const g = new I(r => { open = r; }); g.open = open; gate = g; queueMicrotask(() => { gate = undefined; }); }
  const g = gate; x.then(v => g.open(v), () => {}); return g;
};
`,
} };

const bin = '/bench/node_modules/.bin/flows';
const firstBin = process.env.FIRST_BIN ?? bin;
const resumeBin = process.env.RESUME_BIN ?? bin;
const finalBin = process.env.FINAL_BIN ?? resumeBin;
const daemon = process.env.RELAYFLOWD_BIN ?? '/bench/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd';
const firstDaemon = process.env.FIRST_DAEMON_BIN ?? daemon;
const resumeDaemon = process.env.RESUME_DAEMON_BIN ?? daemon;
const finalDaemon = process.env.FINAL_DAEMON_BIN ?? resumeDaemon;
const fixtureNodeModules = process.env.FIXTURE_NODE_MODULES ?? '/bench/node_modules';
const selected = new Set((process.env.CASE ?? scenarios.map(s => s.name).join(',')).split(','));
const forced = process.env.FORCE_ELIGIBLE === '1';
const baseline = process.env.BASELINE === '1';
const expectRefusal = process.env.EXPECT_ROLLBACK_REFUSAL === '1';
const expectBaseFailure = process.env.EXPECT_BASE_FAILURE === '1';
const parallelCases = new Set(['A1', 'B1', 'N2', 'RBA1', 'RBB1', 'RBN2']);
const delays = [0, 60, 130, 220, 330, 450];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (forced) {
  const file = '/bench/node_modules/@relayflows/sdk/dist/authored-parallel-eligibility.js';
  const source = fs.readFileSync(file, 'utf8');
  const changed = source.replace('export function parallelRunEligible(body, moduleSource) {',
    'export function parallelRunEligible(body, moduleSource) { return true;');
  if (changed === source) throw new Error('reviewer forced-eligibility mutation did not match');
  fs.writeFileSync(file, changed);
}

function start(args, root, executable, daemonBin) {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: root, env: { ...process.env, RELAYFLOWD_BIN: daemonBin }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  return {
    child,
    closed: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))),
    get output() { return output; },
  };
}

function killSweep(root) {
  const connection = path.join(root, 'data/connection.json');
  const targets = new Set();
  if (fs.existsSync(connection)) targets.add(JSON.parse(fs.readFileSync(connection, 'utf8')).pid);
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cwd.startsWith(root) || command.includes(root)) targets.add(pid);
    } catch { /* The process exited during the scan. */ }
  }
  for (const pid of targets) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

const sql = `import sqlite3,json,sys
db=sqlite3.connect(sys.argv[1])
spawn=db.execute("select payload from entries where entry_type='run.spawned' order by seq limit 1").fetchone()
done=db.execute("select count(*) from entries where entry_type='step.completed'").fetchone()[0]
print(json.dumps({'spawned':json.loads(spawn[0]) if spawn else None,'completed':done}))`;
function journals(root) {
  const directory = path.join(root, 'data/runs');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(file => file.endsWith('.sqlite3')).sort().map(file => ({
    runId: file.slice(0, -8),
    ...JSON.parse(execFileSync('python3', ['-c', sql, path.join(directory, file)], { encoding: 'utf8' })),
  }));
}
const spec = record => record?.spawned?.spec ?? record?.spawned?.payload?.spec ?? record?.spawned?.run?.spec;
function rootRecord(records) {
  return records.find(record => spec(record)?.steps?.[0]?.id === 'authored-root');
}
function assertNoReplay(records, rootId) {
  const seen = new Map();
  for (const record of records) {
    if (record.runId === rootId) continue;
    const step = spec(record)?.steps?.[0];
    if (!step?.command || !(step.id.startsWith('run-') || step.id.includes('--run-'))) continue;
    // A dispatched child is a separate flow invocation: two children may
    // intentionally run the same command under different dispatch prefixes.
    const namespace = step.id.includes('--') ? step.id.slice(0, step.id.lastIndexOf('--')) : '';
    const key = `${namespace}|${step.command}`;
    const earlier = seen.get(key);
    if (earlier && earlier.id !== step.id && (earlier.completed > 0 || record.completed > 0)) {
      throw new Error(`journal replay: ${step.command}: ${earlier.id} -> ${step.id}`);
    }
    seen.set(key, { id: step.id, completed: record.completed });
  }
}

async function one(scenario, index) {
  const root = fs.mkdtempSync(`/bench/review7-${scenario.name}-`);
  const data = path.join(root, 'data');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(fixtureNodeModules, path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'flows.json'), JSON.stringify({
    cli: path.join(root, 'adapter.mjs'), models: ['test-model'],
  }));
  fs.writeFileSync(path.join(root, 'adapter.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  for (const [file, source] of Object.entries(scenario.files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.replaceAll('<dir>', root));
  }
  if (scenario.bluebird) {
    const destination = path.join(root, 'bb');
    fs.cpSync('/bench/node_modules/bluebird/js/release', destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'package.json'), '{"type":"commonjs"}');
  }
  let initial;
  let passed = false;
  try {
    initial = start(['run', '--no-observer-link', '--json', ...(scenario.extraArgs ?? []), '--data-dir', data,
      path.join(root, 'chain.flow.ts'), '--input', '{}'], root, firstBin, firstDaemon);
    const deadline = Date.now() + 90_000;
    let early;
    while (!fs.existsSync(path.join(root, 'stalled'))) {
      if (initial.child.exitCode !== null || initial.child.signalCode !== null) {
        early = await initial.closed;
        break;
      }
      if (Date.now() >= deadline) throw new Error(`fresh stall timeout: ${initial.output}`);
      await sleep(15);
    }
    if (early) {
      const effects = fs.existsSync(path.join(root, 'effects'))
        ? fs.readFileSync(path.join(root, 'effects'), 'utf8') : '';
      const records = journals(root);
      const rootRun = rootRecord(records);
      const mode = rootRun ? JSON.parse(spec(rootRun).steps[0].instruction).executionMode : undefined;
      if (expectBaseFailure && early.code !== 0 && /run_admission_conflict/u.test(initial.output)
        && new Set(effects).size === effects.length) {
        console.log(JSON.stringify({ case: scenario.name, index, mode, outcome: 'base_failure', effects }));
        passed = true;
        return;
      }
      if (!forced || !scenario.name.startsWith('FR') || early.code === 0 || effects !== '' || mode !== 'parallel') {
        throw new Error(`base-working fresh run failed: mode=${mode}, effects=${effects}, exit=${early.code}: ${initial.output}`);
      }
      assertNoReplay(records, rootRun.runId);
      console.log(JSON.stringify({ case: scenario.name, index, mode, outcome: 'failed_closed', effects }));
      passed = true;
      return;
    }
    await sleep(delays[index]);
    initial.child.kill('SIGKILL');
    await Promise.race([initial.closed, sleep(2_000).then(() => { throw new Error('CLI kill timeout'); })]);
    killSweep(root);
    await sleep(100);
    killSweep(root);
    fs.writeFileSync(path.join(root, 'release'), '');
    const before = fs.existsSync(path.join(root, 'effects')) ? fs.readFileSync(path.join(root, 'effects'), 'utf8') : '';
    const records = journals(root);
    const rootRun = rootRecord(records);
    if (!rootRun) throw new Error('missing root journal');
    const mode = JSON.parse(spec(rootRun).steps[0].instruction).executionMode;
    if (forced && mode !== 'parallel') throw new Error(`forced mode was ${mode}`);
    const expectedMode = parallelCases.has(scenario.name) ? 'parallel' : 'serial';
    if (!forced && mode !== expectedMode && !(baseline && mode === undefined))
      throw new Error(`natural ${scenario.name} mode was ${mode}`);
    const resumed = start(['resume', '--no-observer-link', '--json', ...(scenario.extraArgs ?? []), '--data-dir', data,
      rootRun.runId], root, resumeBin, resumeDaemon);
    const timeout = setTimeout(() => resumed.child.kill('SIGKILL'), 150_000);
    const result = await resumed.closed;
    clearTimeout(timeout);
    if (expectRefusal && mode === 'parallel') {
      if (result.code === 0 || !/malformed authority metadata|unsupported.*parallel|refus/iu.test(resumed.output)) {
        throw new Error(`parallel rollback did not refuse: ${resumed.output}`);
      }
      const refusedEffects = fs.existsSync(path.join(root, 'effects'))
        ? fs.readFileSync(path.join(root, 'effects'), 'utf8') : '';
      if (refusedEffects !== before) throw new Error(`rollback admitted an effect: ${before} -> ${refusedEffects}`);
      const final = start(['resume', '--no-observer-link', '--json', ...(scenario.extraArgs ?? []), '--data-dir', data,
        rootRun.runId], root, finalBin, finalDaemon);
      const finalResult = await final.closed;
      if (finalResult.code !== 0) throw new Error(`head could not resume after rollback refusal: ${final.output}`);
    } else if (expectBaseFailure && result.code !== 0
      && /run_admission_conflict/u.test(resumed.output)) {
      const effects = fs.existsSync(path.join(root, 'effects'))
        ? fs.readFileSync(path.join(root, 'effects'), 'utf8') : '';
      if (new Set(effects).size !== effects.length) throw new Error(`effect replay before base failure: ${effects}`);
      console.log(JSON.stringify({ case: scenario.name, index, mode, outcome: 'base_failure', effects }));
      passed = true;
      return;
    } else if (result.code !== 0) throw new Error(`resume failed: ${resumed.output}`);
    const after = fs.existsSync(path.join(root, 'effects')) ? fs.readFileSync(path.join(root, 'effects'), 'utf8') : '';
    if (after.length === 0 || !after.includes('Z') || new Set(after).size !== after.length)
      throw new Error(`effect replay: before=${before}, after=${after}`);
    assertNoReplay(journals(root), rootRun.runId);
    console.log(JSON.stringify({ case: scenario.name, index, mode, outcome: 'resumed', before, after }));
    passed = true;
  } finally {
    if (initial?.child.exitCode === null && initial.child.signalCode === null) initial.child.kill('SIGKILL');
    killSweep(root);
    if (passed || process.env.KEEP_FAILURE !== '1') fs.rmSync(root, { recursive: true, force: true });
    else console.error(`preserved failed fixture: ${root}`);
  }
}

for (const scenario of [...scenarios, ...baseScenarios, r5n].filter(value => selected.has(value.name))) {
  for (let index = 0; index < delays.length; index++) await one(scenario, index);
}
console.log(JSON.stringify({ done: true, cases: [...selected], repetitions: delays.length, forced }));
