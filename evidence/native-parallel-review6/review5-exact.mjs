import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

// Source blocks are loaded from the copied reviewer brief byte for byte.
const brief = fs.readFileSync('/bench/review5-fixtures.md', 'utf8');
const names = ['Q5', 'Q5n', 'Q5h', 'Q5w', 'Q5wn', 'Q5wh', 'Q6Pw'];
const delays = [0, 60, 130, 220, 330, 450];
const bin = '/bench/node_modules/.bin/flows';
const daemon = '/bench/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd';
const mutation = process.env.REVIEW5_MUTATION;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function mutateDist() {
  if (mutation === undefined) return;
  const dist = '/bench/node_modules/@relayflows/sdk/dist';
  const eligibilityPath = path.join(dist, 'authored-parallel-eligibility.js');
  const eligibility = fs.readFileSync(eligibilityPath, 'utf8');
  const forced = eligibility.replace('export function parallelRunEligible(body, moduleSource) {',
    'export function parallelRunEligible(body, moduleSource) { return true;');
  if (forced === eligibility) throw new Error('eligibility mutation did not match');
  fs.writeFileSync(eligibilityPath, forced);
  if (mutation !== 'forced_no_guard') return;
  const graphPath = path.join(dist, 'authored-promise-graph.js');
  const graph = fs.readFileSync(graphPath, 'utf8');
  const disabled = graph.replace(/hasUnobservedJoinShape\(asyncId\) \{[\s\S]*?\n    \}/u,
    'hasUnobservedJoinShape(asyncId) { return false; }');
  if (disabled === graph) throw new Error('guard mutation did not match');
  fs.writeFileSync(graphPath, disabled);
}

function sourceBlocks(name) {
  const section = brief.split(/^## /mu).find(part => part.startsWith(`${name} (`));
  if (section === undefined) throw new Error(`missing reviewer source for ${name}`);
  const blocks = [...section.matchAll(/```(?:ts|js)\n([\s\S]*?)```/gu)].map(match => match[1]);
  if (blocks.length !== 2) throw new Error(`${name}: expected two exact source blocks, got ${blocks.length}`);
  return blocks;
}

function start(args, root) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: root, env: { ...process.env, RELAYFLOWD_BIN: daemon }, stdio: ['ignore', 'pipe', 'pipe'],
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
  for (const item of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(item)) continue;
    const pid = Number(item);
    if (pid === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cwd.startsWith(root) || cmdline.includes(root)) targets.add(pid);
    } catch { /* process exited during the sweep */ }
  }
  for (const pid of targets) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

const sql = `import sqlite3,json,sys
db=sqlite3.connect(sys.argv[1])
row=db.execute("select payload from entries where entry_type='run.spawned' order by seq limit 1").fetchone()
count=db.execute("select count(*) from entries where entry_type='step.completed'").fetchone()[0]
print(json.dumps({'spawned':json.loads(row[0]) if row else None,'completed':count}))`;
function readJournal(file) {
  return JSON.parse(execFileSync('python3', ['-c', sql, file], { encoding: 'utf8' }));
}
function spawnedSpec(spawned) {
  return spawned?.spec ?? spawned?.payload?.spec ?? spawned?.run?.spec;
}
function journals(root) {
  const files = fs.readdirSync(path.join(root, 'data/runs')).filter(name => name.endsWith('.sqlite3')).sort();
  return files.map(file => {
    const runId = file.slice(0, -8);
    return { runId, ...readJournal(path.join(root, 'data/runs', file)) };
  });
}
function assertNoJournalReplay(records, rootId) {
  const seen = new Map();
  for (const record of records) {
    if (record.runId === rootId) continue;
    const step = spawnedSpec(record.spawned)?.steps?.[0];
    if (step?.command === undefined) continue;
    const earlier = seen.get(step.command);
    if (earlier !== undefined && earlier.id !== step.id && (earlier.completed > 0 || record.completed > 0))
      throw new Error(`journal replay: ${step.command}: ${earlier.id} -> ${step.id}`);
    seen.set(step.command, { id: step.id, completed: record.completed });
  }
}

async function one(name, index) {
  const root = fs.mkdtempSync(`/bench/review5-${name}-`);
  const data = path.join(root, 'data');
  const [entrySource, otherSource] = sourceBlocks(name);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync('/bench/node_modules', path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'flows.json'), JSON.stringify({
    cli: path.join(root, 'adapter.mjs'), models: ['test-model'],
  }));
  fs.writeFileSync(path.join(root, 'adapter.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'chain.flow.ts'), entrySource);
  if (name === 'Q6Pw') {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib/patch.mjs'), otherSource);
  } else fs.writeFileSync(path.join(root, 'impl.ts'), otherSource);
  let original;
  try {
    original = start(['run', '--no-observer-link', '--json', '--data-dir', data,
      path.join(root, 'chain.flow.ts'), '--input', '{}'], root);
    const deadline = Date.now() + 90_000;
    let freshFailure;
    while (!fs.existsSync(path.join(root, 'stalled'))) {
      if (original.child.exitCode !== null || original.child.signalCode !== null) {
        freshFailure = await original.closed;
        break;
      }
      if (Date.now() >= deadline) throw new Error(`${name} fresh stall timeout: ${original.output}`);
      await sleep(15);
    }
    if (freshFailure !== undefined) {
      if ((name !== 'Q6Pw' && !(name === 'Q5w' && mutation === 'forced_guard')) || freshFailure.code === 0)
        throw new Error(`${name} base-working fresh run failed: ${original.output}`);
      const effects = fs.existsSync(path.join(root, 'effects'))
        ? fs.readFileSync(path.join(root, 'effects'), 'utf8') : '';
      if (effects.includes('X')) throw new Error(`${name} admitted completed X before refusal: ${effects}`);
      const records = journals(root);
      const rootRecord = records.find(record => spawnedSpec(record.spawned)?.steps?.[0]?.id === 'authored-root');
      if (rootRecord === undefined) throw new Error(`${name} has no authored root`);
      const mode = JSON.parse(spawnedSpec(rootRecord.spawned).steps[0].instruction).executionMode;
      if (mode !== 'parallel') throw new Error(`${name} expected parallel mode, got ${mode}`);
      assertNoJournalReplay(records, rootRecord.runId);
      console.log(JSON.stringify({ name, index, mode, result: 'failed_closed', effects }));
      return;
    }
    await sleep(delays[index]);
    original.child.kill('SIGKILL');
    await Promise.race([original.closed, sleep(2_000).then(() => { throw new Error('CLI did not exit after SIGKILL'); })]);
    killSweep(root);
    await sleep(100);
    killSweep(root);
    fs.writeFileSync(path.join(root, 'release'), '');
    const before = fs.readFileSync(path.join(root, 'effects'), 'utf8');
    const recordsBefore = journals(root);
    const rootRecord = recordsBefore.find(record => spawnedSpec(record.spawned)?.steps?.[0]?.id === 'authored-root');
    if (rootRecord === undefined) throw new Error(`${name} has no authored root`);
    const mode = JSON.parse(spawnedSpec(rootRecord.spawned).steps[0].instruction).executionMode;
    if (name.startsWith('Q5') && mode !== (mutation === undefined ? 'serial' : 'parallel'))
      throw new Error(`${name} unexpected mode ${mode}`);
    const resumed = start(['resume', '--no-observer-link', '--json', '--data-dir', data, rootRecord.runId], root);
    const timer = setTimeout(() => resumed.child.kill('SIGKILL'), 150_000);
    const result = await resumed.closed;
    clearTimeout(timer);
    if (result.code !== 0) throw new Error(`${name} resume failed: ${resumed.output}`);
    const after = fs.readFileSync(path.join(root, 'effects'), 'utf8');
    const expected = name.includes('n') || name === 'Q6Pw' ? 'abcXZ' : 'XZ';
    if (mutation === 'forced_no_guard' && name === 'Q5w') {
      const replayed = (after.match(/X/gu) ?? []).length > 1;
      if (!['XZ', 'XXZ'].includes(after)) throw new Error(`unexpected mutation effects: ${after}`);
      console.log(JSON.stringify({ name, index, mode,
        result: replayed ? 'replayed_under_mutation' : 'no_replay_this_timing', before, after }));
      return replayed;
    }
    if (after.split('').sort().join('') !== expected.split('').sort().join(''))
      throw new Error(`${name} effects replay: before=${before}, after=${after}, expected=${expected}`);
    assertNoJournalReplay(journals(root), rootRecord.runId);
    console.log(JSON.stringify({ name, index, mode, result: 'resumed', before, after }));
  } finally {
    if (original?.child.exitCode === null && original.child.signalCode === null) original.child.kill('SIGKILL');
    killSweep(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const requested = process.env.CASE?.split(',');
mutateDist();
let replays = 0;
for (const name of names.filter(value => requested === undefined || requested.includes(value))) {
  for (let index = 0; index < 6; index++) if (await one(name, index) === true) replays++;
}
if (mutation === 'forced_no_guard' && replays === 0) throw new Error('disabled guard did not expose the replay');
console.log(JSON.stringify({ done: true, cases: requested ?? names, repetitions: 6, mutation, replays }));
