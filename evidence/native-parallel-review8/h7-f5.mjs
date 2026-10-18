// Review-7 crash/resume harness for flows#667. Runs inside node:22-trixie.
// usage: node --no-warnings h7.mjs <scenarios.mjs> <A,B,...|all> [--reps=6] [--conc=3] [--tag=x] [--sides=a:b/c:d] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
globalThis.require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const file = args[0];
const names = args[1];
const reps = Number(opt('reps', '6'));
const conc = Number(opt('conc', '3'));
const tag = opt('tag', 't');
const sidesOverride = opt('sides', undefined)?.split('/').map(p => p.split(':'));
const keep = args.includes('--keep');
const DELAYS = [0, 60, 130, 220, 330, 450, 30, 180, 270, 400];

const SIDES = {
  head: { cli: '/w/head/packages/sdk/dist/cli.js', nm: '/w/head/packages/sdk/node_modules', daemon: '/w/relayflowd-main' },
  base: { cli: '/w/base/packages/sdk/dist/cli.js', nm: '/w/base/packages/sdk/node_modules', daemon: '/w/relayflowd-main' },
  forced: { cli: '/w/forced/packages/sdk/dist/cli.js', nm: '/w/head/packages/sdk/node_modules', daemon: '/w/relayflowd-main' },
  fix: { cli: '/w/fix/packages/sdk/dist/cli.js', nm: '/w/head/packages/sdk/node_modules', daemon: '/w/relayflowd-main' },
  deep: { cli: '/w/deep-f5/packages/sdk/dist/cli.js', nm: '/w/head/packages/sdk/node_modules', daemon: '/w/relayflowd-main' },
  p2050: { cli: '/w/p2050/node_modules/@relayflows/sdk/dist/cli.js', nm: '/w/p2050/node_modules', daemon: '/w/relayflowd-2050' },
  p2051: { cli: '/w/p2051/node_modules/@relayflows/sdk/dist/cli.js', nm: '/w/p2051/node_modules', daemon: '/w/relayflowd-main' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function start(side, argv, root, env = {}) {
  const s = SIDES[side];
  const child = spawn(process.execPath, [s.cli, ...argv], {
    cwd: root, env: { ...process.env, ...env, RELAYFLOWD_BIN: s.daemon }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return { child, closed: new Promise(r => child.once('close', (code, signal) => r({ code, signal }))), get out() { return out; } };
}

function sweep(root) {
  const targets = new Set();
  try { targets.add(JSON.parse(read(path.join(root, 'data/connection.json'))).pid); } catch {}
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cwd === root || cwd.startsWith(root + '/') || cmd.includes(root)) targets.add(pid);
    } catch {}
  }
  for (const pid of targets) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch {} }
}

function journals(root) {
  const dir = path.join(root, 'data/runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.sqlite3')).sort().map(f => {
    let db;
    try { db = new DatabaseSync(path.join(dir, f), { readOnly: true }); } catch { return { runId: f.slice(0, -8), step: undefined, completed: 0 }; }
    try {
      if (!db.prepare("select name from sqlite_master where type='table' and name='entries'").get()) return { runId: f.slice(0, -8), step: undefined, completed: 0 };
      const sp = db.prepare("select payload from entries where entry_type='run.spawned' order by seq limit 1").get();
      const done = db.prepare("select count(*) as n from entries where entry_type='step.completed'").get().n;
      const payload = sp ? JSON.parse(sp.payload) : undefined;
      const spec = payload?.spec ?? payload?.payload?.spec ?? payload?.run?.spec;
      return { runId: f.slice(0, -8), step: spec?.steps?.[0], completed: Number(done) };
    } finally { db.close(); }
  });
}

function rootOf(js) { return js.find(j => j.step?.id === 'authored-root'); }
function modeOf(r) {
  try { const m = JSON.parse(r.step.instruction); return m.executionMode ?? (m.identityVersion ? 'v2?' : 'absent'); } catch { return 'unknown'; }
}

function replayCheck(js, rootId, expected = {}) {
  const seen = new Map();
  const ids = [];
  let replay = false;
  const dups = [];
  for (const j of js) {
    if (j.runId === rootId || !j.step) continue;
    const st = j.step;
    const cmd = st.command ?? st.instruction ?? '';
    ids.push(`${st.id} c=${j.completed} ${String(cmd).slice(0, 70)}`);
    if (!st.command) continue;
    const ns = st.id.includes('--') ? st.id.slice(0, st.id.lastIndexOf('--')) : '';
    const key = `${ns}|${st.command}`;
    const prev = seen.get(key) ?? [];
    prev.push({ id: st.id, completed: j.completed });
    seen.set(key, prev);
    const distinct = new Set(prev.map(p => p.id));
    if (distinct.size > (expected[st.command] ?? 1) && prev.some(p => p.completed > 0)) {
      replay = true; dups.push(`${st.command.slice(0, 50)}: ${[...distinct].join(' & ')}`);
    }
  }
  return { replay, ids, dups };
}

async function one(sc, startSide, resumeSide, i) {
  const root = `/w/runs/${tag}/${sc.name}/${startSide}-${resumeSide}-${i}`;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const nmSide = sc.nmSide ?? startSide;
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(SIDES[nmSide].nm, path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'flows.json'), JSON.stringify({ cli: path.join(root, 'adapter.mjs'), models: ['test-model'] }));
  fs.writeFileSync(path.join(root, 'adapter.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  for (const [f, src] of Object.entries(sc.files)) {
    const t = path.join(root, f);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, src.replaceAll('<dir>', root));
    if (f.endsWith('adapter.mjs')) fs.chmodSync(t, 0o755);
  }
  if (sc.bluebird) {
    const d = path.join(root, 'bb');
    fs.cpSync('/w/head/packages/sdk/node_modules/bluebird/js/release', d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{"type":"commonjs"}');
  }
  const env = Object.fromEntries(Object.entries(sc.env ?? {}).map(([k, v]) => [k, String(v).replaceAll('<dir>', root)]));
  const entry = path.join(root, sc.entry ?? 'chain.flow.ts');
  const res = { s: sc.name, start: startSide, resume: resumeSide, i };
  const t0 = Date.now();
  const first = start(startSide, ['run', '--no-observer-link', '--json', ...(sc.extraArgs ?? []), '--data-dir', path.join(root, 'data'), entry, '--input', '{}'], root, env);
  let early;
  const deadline = Date.now() + 8_000;
  while (!fs.existsSync(path.join(root, 'stalled'))) {
    if (first.child.exitCode !== null || first.child.signalCode !== null) { early = await first.closed; break; }
    if (Date.now() > deadline) { first.child.kill('SIGKILL'); early = { code: 'timeout' }; break; }
    await sleep(15);
  }
  try {
    if (early) {
      res.fresh = true; res.code1 = early.code; res.code = early.code;
      res.effects1 = res.effects = read(path.join(root, 'effects'));
      res.out1 = first.out.slice(-600);
    } else {
      res.fresh = false;
      await sleep(sc.delays?.[i] ?? DELAYS[i % DELAYS.length]);
      first.child.kill('SIGKILL');
      await Promise.race([first.closed, sleep(2000)]);
      sweep(root); await sleep(100); sweep(root);
      res.code1 = 'killed';
      res.effects1 = read(path.join(root, 'effects'));
      fs.writeFileSync(path.join(root, 'release'), '');
      const r0 = rootOf(journals(root));
      if (!r0) throw new Error('no root journal');
      const resumed = start(resumeSide, ['resume', '--no-observer-link', '--json', ...(sc.extraArgs ?? []), '--data-dir', path.join(root, 'data'), r0.runId], root, env);
      const to = setTimeout(() => resumed.child.kill('SIGKILL'), 150_000);
      const rr = await resumed.closed; clearTimeout(to);
      res.code = rr.code; res.out = resumed.out.slice(-600);
      sweep(root);
      if (sc.secondResume) {
        res.effects0 = res.effects1;
        res.effectsMid = read(path.join(root, 'effects'));
        res.code1 = rr.code; res.effects1 = res.effectsMid;
        const fin = start(sc.secondResume, ['resume', '--no-observer-link', '--json', ...(sc.extraArgs ?? []), '--data-dir', path.join(root, 'data'), r0.runId], root, env);
        const to2 = setTimeout(() => fin.child.kill('SIGKILL'), 150_000);
        const fr = await fin.closed; clearTimeout(to2);
        res.code = fr.code; res.out2 = fin.out.slice(-400);
        sweep(root);
      }
      res.effects = read(path.join(root, 'effects'));
    }
    const js = journals(root);
    const r = rootOf(js);
    res.mode = r ? modeOf(r) : 'noroot';
    const rc = replayCheck(js, r?.runId, sc.expectedCounts);
    res.journalReplay = rc.replay; res.dups = rc.dups; res.ids = rc.ids;
    const letters = [...res.effects].filter(c => /[A-Za-z]/.test(c));
    res.letterDup = new Set(letters).size !== letters.length;
    res.replay = res.journalReplay || (res.letterDup && !sc.allowDupLetters);
    if (sc.extraCheck) Object.assign(res, sc.extraCheck(root));
    const okDefault = r => r.code === 0 && !r.replay && (sc.noZ || r.effects.includes('Z'));
    res.ok = sc.okIf ? (sc.okIf(res) && !res.replay) : sc.expect ? (sc.expect(res) && !res.replay && res.code === 0) : okDefault(res);
  } catch (e) {
    res.error = String(e?.stack ?? e).slice(0, 400); res.ok = false;
  } finally {
    try { first.child.kill('SIGKILL'); } catch {}
    sweep(root);
    res.ms = Date.now() - t0;
    if (!keep && res.ok) fs.rmSync(root, { recursive: true, force: true });
  }
  return res;
}

const mod = await import(path.resolve(file));
let scen = mod.default;
if (names !== 'all') { const want = names.split(','); scen = want.map(n => { const s = scen.find(x => x.name === n); if (!s) throw new Error(`no scenario ${n}`); return s; }); }
const jobs = [];
for (const sc of scen) for (const [a, b] of (sidesOverride ?? sc.sides)) for (let i = 0; i < reps; i++) jobs.push([sc, a, b, i]);
const results = [];
let next = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < jobs.length) {
    const [sc, a, b, i] = jobs[next++];
    const r = await one(sc, a, b, i);
    results.push(r);
    console.log(JSON.stringify(r));
  }
}));
const groups = new Map();
for (const r of results) {
  const k = `${r.s} ${r.start}>${r.resume}`;
  const g = groups.get(k) ?? { ok: 0, n: 0, replay: 0, fresh: 0, modes: new Set(), effects: new Set(), codes: new Set() };
  g.n++; if (r.ok) g.ok++; if (r.replay) g.replay++; if (r.fresh) g.fresh++;
  g.modes.add(r.mode); g.effects.add(r.effects); g.codes.add(String(r.code));
  groups.set(k, g);
}
for (const [k, g] of groups) console.log(`SUMMARY ${k} ok=${g.ok}/${g.n} replay=${g.replay} fresh=${g.fresh} mode=${[...g.modes]} codes=${[...g.codes]} effects=${[...g.effects].join('|')}`);
