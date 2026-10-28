// Native shape timing: 3 x 300 ms routes, each followed by a 100 ms dependent, then a join.
// Alternates head and base, 1 warm-up each, then N measured pairs. Timestamps come from the
// shell children themselves (date +%s%3N), so overlap is measured on the effects, not the journal.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const N = Number(process.argv[2] ?? 10);
const SIDES = {
  head: { cli: '/w/head/packages/sdk/dist/cli.js', nm: '/w/head/packages/sdk/node_modules' },
  base: { cli: '/w/base/packages/sdk/dist/cli.js', nm: '/w/base/packages/sdk/node_modules' },
};
const step = (tag, secs) => `echo "${tag}0 $(date +%s%3N)" >> t; sleep ${secs}; echo "${tag}1 $(date +%s%3N)" >> t`;
const SRC = `import { flow } from '@relayflows/surface';
export default flow('timing', async f => {
  const a = async () => { await f.run('${step('RA', 0.3)}'); await f.run('${step('DA', 0.1)}'); };
  const b = async () => { await f.run('${step('RB', 0.3)}'); await f.run('${step('DB', 0.1)}'); };
  const c = async () => { await f.run('${step('RC', 0.3)}'); await f.run('${step('DC', 0.1)}'); };
  await Promise.all([a(), b(), c()]);
  f.done('success');
});
`;
function once(side, i) {
  const root = `/w/runs/timing/${side}-${i}`;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(SIDES[side].nm, path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'chain.flow.ts'), SRC);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SIDES[side].cli, 'run', '--no-observer-link', '--json', '--data-dir', path.join(root, 'data'), path.join(root, 'chain.flow.ts'), '--input', '{}'],
    { cwd: root, env: { ...process.env, RELAYFLOWD_BIN: '/w/relayflowd-main' }, encoding: 'utf8' });
  const cli = Date.now() - t0;
  const t = Object.fromEntries(fs.readFileSync(path.join(root, 't'), 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, v]) => [k, Number(v)]));
  const routes = ['A', 'B', 'C'].map(x => [t[`R${x}0`], t[`R${x}1`]]);
  const deps = ['A', 'B', 'C'].map(x => [t[`D${x}0`], t[`D${x}1`]]);
  const overlap = (iv) => Math.max(...iv.map(v => v[0])) < Math.min(...iv.map(v => v[1]));
  const first = Math.min(...routes.map(v => v[0]));
  const last = Math.max(...deps.map(v => v[1]));
  const mode = JSON.parse(spawnSync('python3', ['-c', `import sqlite3,json,glob
for f in sorted(glob.glob('${root}/data/runs/*.sqlite3')):
  r=sqlite3.connect(f).execute("select payload from entries where entry_type='run.spawned' order by seq limit 1").fetchone()
  s=json.loads(r[0]).get('spec',{}).get('steps',[{}])[0]
  if s.get('id')=='authored-root': print(json.dumps(json.loads(s['instruction']).get('executionMode','absent'))); break`], { encoding: 'utf8' }).stdout || '"?"');
  fs.rmSync(root, { recursive: true, force: true });
  return { side, i, code: r.status, mode, cli, body: last - first, routeSpread: Math.max(...routes.map(v => v[0])) - first,
    routesOverlap: overlap(routes), depsOverlap: overlap(deps) };
}
const out = { head: [], base: [] };
once('head', -1); once('base', -1);
for (let i = 0; i < N; i++) for (const side of i % 2 ? ['base', 'head'] : ['head', 'base']) { const r = once(side, i); out[side].push(r); console.log(JSON.stringify(r)); }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
for (const side of ['head', 'base']) {
  const rs = out[side];
  console.log(`TIMING ${side} mode=${[...new Set(rs.map(r => r.mode))]} codes=${[...new Set(rs.map(r => r.code))]} body p50=${q(rs.map(r => r.body), 0.5)} max=${Math.max(...rs.map(r => r.body))} cli p50=${q(rs.map(r => r.cli), 0.5)} max=${Math.max(...rs.map(r => r.cli))} spread p50=${q(rs.map(r => r.routeSpread), 0.5)} routesOverlap=${rs.filter(r => r.routesOverlap).length}/${rs.length} depsOverlap=${rs.filter(r => r.depsOverlap).length}/${rs.length}`);
}
