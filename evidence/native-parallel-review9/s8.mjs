// Review-8 new attack scenarios for flows#667 (head 3e008e9e). Run with h8.mjs.
import { SURF, flowSrc, NAT, W2, TAIL5 } from './s.mjs';
const HS = [['head', 'head'], ['base', 'base']];
const S = [];
const add = (s) => S.push({ sides: HS, ...s });
const perm = (letters) => (e) => e.length === letters.length && [...letters].every(c => e.split(c).length - 1 === letters.split(c).length - 1);
const NATW = (name) => flowSrc(name, `
  await f.run('sleep 0.2; printf W');
${NAT}  await f.run('printf X >> effects');`);

// ---- F3 bypasses. R5 patch made native-looking with a Proxy (passes the
// "[native code]" toString test), then hidden from the flag check.
const R5PROXY = `const I = Function('return this')()['Pro' + 'mise'];
const resolve = I.resolve;
let gate;
I.resolve = new Proxy(resolve, { apply(target, self, args) {
  const x = args[0];
  if (self !== I || !(x instanceof I) || !/at (Promise|Function)\\.all /.test(new Error().stack)) return Reflect.apply(target, self, args);
  if (gate === undefined) {
    let open; const g = new I(r => { open = r; }); g.open = open; gate = g;
    queueMicrotask(() => { gate = undefined; });
  }
  const g = gate;
  x.then(v => g.open(v), () => {});
  return g;
} });
`;
const R5PLAIN = `const I = Function('return this')()['Pro' + 'mise'];
const resolve = I.resolve;
let gate;
I.resolve = function (x) {
  if (this !== I || !(x instanceof I) || !/at (Promise|Function)\\.all /.test(new Error().stack)) return resolve.call(this, x);
  if (gate === undefined) {
    let open; const g = new I(r => { open = r; }); g.open = open; gate = g;
    queueMicrotask(() => { gate = undefined; });
  }
  const g = gate;
  x.then(v => g.open(v), () => {});
  return g;
};
`;
// Non-snapshotted intrinsic: Promise.all's own iteration of a 3-promise array
// sees only the middle member, so the aggregate resolves when b's branch does.
const ITER = `const AP = Array.prototype; const iter = AP[Symbol.iterator];
const P = Function('return this')()['Pro' + 'mise'];
Object.defineProperty(AP, Symbol.iterator, { value: function values() {
  if (this.length === 3 && this.every(x => x instanceof P)) {
    const st = new Error().stack;
    if (/at (Promise|Function)\\.all \\(<anonymous>\\)/.test(st) && !/collectMembers/.test(st)) return iter.call([this[1]]);
  }
  return iter.call(this);
}, writable: true, configurable: true });
`;
const ok5 = r => perm('abcXZ')(r.effects);
add({ name: 'PL8r', nodeArgs: ['-r', '<dir>/lib/pre.cjs'], files: { 'chain.flow.ts': NATW('pl8r'), 'lib/pre.cjs': R5PROXY }, expect: ok5 });
add({ name: 'PL8rplain', nodeArgs: ['-r', '<dir>/lib/pre.cjs'], files: { 'chain.flow.ts': NATW('pl8rplain'), 'lib/pre.cjs': R5PLAIN }, expect: ok5 });
add({ name: 'PL8hide', env: { NODE_OPTIONS: '--import=<dir>/lib/pre.mjs' }, files: { 'chain.flow.ts': NATW('pl8hide'), 'lib/pre.mjs': `${R5PROXY}delete process.env.NODE_OPTIONS;\n` }, expect: ok5 });
add({ name: 'PL8iter', nodeArgs: ['-r', '<dir>/lib/pre.cjs'], files: { 'chain.flow.ts': NATW('pl8iter'), 'lib/pre.cjs': ITER }, expect: ok5 });
// Dependency patch at import time of the flow module (no preload at all): the
// installed @relayflows/surface is a shim that patches, then re-exports the real one.
const shim = (patch) => ({
  'node_modules/@relayflows/surface/package.json': JSON.stringify({ name: '@relayflows/surface', version: '2.0.51', type: 'module', exports: { '.': './index.js', './runtime': './runtime.js' } }),
  'node_modules/@relayflows/surface/index.js': `import './patch.js';\nexport * from '<nm>/@relayflows/surface/dist/index.js';\n`,
  'node_modules/@relayflows/surface/runtime.js': `export * from '<nm>/@relayflows/surface/dist/runtime.js';\n`,
  'node_modules/@relayflows/surface/patch.js': patch,
});
add({ name: 'PL9dep', realNodeModules: true, files: { 'chain.flow.ts': NATW('pl9dep'), ...shim(ITER) }, expect: ok5 });
add({ name: 'PL9depsnap', realNodeModules: true, files: { 'chain.flow.ts': NATW('pl9depsnap'), ...shim(R5PROXY) }, expect: ok5 });
add({ name: 'PL9depnone', realNodeModules: true, files: { 'chain.flow.ts': NATW('pl9depnone'), ...shim('') }, expect: ok5 });

// ---- Resume under a different NODE_OPTIONS than the fresh run (pinned parallel root).
for (const [n, opts] of [['RS1', '--dns-result-order=ipv4first'], ['RS2', '--unhandled-rejections=strict'], ['RS3', '--require=<dir>/lib/noop.cjs'], ['RS0', '--max-old-space-size=2048']]) {
  add({ name: n, resumeEnv: { NODE_OPTIONS: opts }, files: { 'chain.flow.ts': NATW(n.toLowerCase()), 'lib/noop.cjs': 'module.exports = 1;\n' }, expect: ok5 });
  for (const side of ['head', 'base']) S.push({ name: `${n}b${side[0]}`, sides: [[side, side]], secondResume: side, resumeEnv: { NODE_OPTIONS: opts },
    files: { 'chain.flow.ts': NATW(`${n.toLowerCase()}b`), 'lib/noop.cjs': 'module.exports = 1;\n' }, expect: ok5 });
}

// ---- Certified natural shapes (probe8: certified=true) run end to end.
add({ name: 'DP1', files: { 'chain.flow.ts': flowSrc('dp1', `
  await f.run('sleep 0.1; printf W');
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  await Promise.all([((a())), (((b())))]);
  await f.run('printf X >> effects');`) }, expect: r => perm('abXZ')(r.effects) });
add({ name: 'OPT1', files: { 'chain.flow.ts': flowSrc('opt1', `
  await f.run('sleep 0.1; printf W');
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  await Promise.all([(a?.()), (b())]);
  await f.run('printf X >> effects');`) }, expect: r => perm('abXZ')(r.effects) });
add({ name: 'TV1', files: { 'chain.flow.ts': flowSrc('tv1', `
  const v = await f.run('sleep 0.1; printf vv');
  const a = async () => { await f.run(\`sleep 0.3; printf \${v}\`); await f.run(\`printf a\${v.length} >> effects\`); };
  const b = async () => { const r = await f.run('sleep 0.1; exit 4', { onNonZero: 'record' }); await f.run(\`printf b\${r.exitCode} >> effects\`); };
  await Promise.all([a(), b()]);
  await f.run(\`printf X >> effects\`);`) }, expect: r => perm('a2b4XZ')(r.effects) && r.effects.includes('a2') && r.effects.includes('b4') });
add({ name: 'EP1', files: { 'chain.flow.ts': flowSrc('ep1', `
  const v = await f.run('sleep 0.1; printf vv');
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a' + v['length'] + ' >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b' + (v[0] === 'v' ? 'y' : 'n') + ' >> effects'); };
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`) }, expect: r => r.effects.includes('a2') && r.effects.includes('by') && perm('a2byXZ')(r.effects) });

// ---- F4: thenable refusal and its neighbours (deep-forced), compared with base.
const DB = [['deep', 'deep'], ['base', 'base']];
const deep = (name, body, extra = {}) => S.push({ name, sides: DB, files: { 'chain.flow.ts': flowSrc(name.toLowerCase(), body) }, ...extra });
deep('FT1wrap', `
  await f.run('sleep 0.2; printf W');
  const sa = f.run('sleep 0.3; printf A');
  const th = Promise.resolve({ then: (r, j) => sa.then(r, j) });
  await Promise.all([th, f.run('sleep 0.1; printf B')]);
  await f.run('printf X >> effects');`);
deep('FT2asyncStep', `
  await f.run('sleep 0.2; printf W');
  const a = async () => f.run('sleep 0.3; printf A');
  await Promise.all([a(), f.run('sleep 0.1; printf B')]);
  await f.run('printf X >> effects');`);
deep('FT3retThen', `
  await f.run('sleep 0.2; printf W');
  const a = async () => { await f.run('sleep 0.3; printf A'); return { then(r) { setTimeout(() => r(1), 20); } }; };
  const b = async () => { await f.run('sleep 0.1; printf B'); };
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`);
deep('FT4awaitThen', `
  await f.run('sleep 0.2; printf W');
  const a = async () => { await f.run('sleep 0.3; printf A'); await { then(r) { setTimeout(() => r(1), 20); } }; await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`);
deep('FT5wrapped', `
  await f.run('sleep 0.2; printf W');
  await Promise.all([{ s: f.run('sleep 0.3; printf A') }, f.run('sleep 0.1; printf B')]);
  await f.run('printf X >> effects');`);

// ---- F5: prompt failure; nothing admitted after the violation (deep-forced).
deep('F5x', `
  const a = async () => { await f.run('sleep 0.1; printf A >> effects'); await Promise.all([f.run('printf a1'), { then(r) { r(1); } }]); await f.run('printf Q >> effects'); };
  const b = async () => { await f.run('sleep 0.6; printf B >> effects'); await f.run('printf L >> effects'); };
  await Promise.all([a(), b()]);`, { okIf: r => r.code !== 0 && !/[QLZ]/.test(r.effects) });
deep('F5w', `
  const a = async () => { await f.run('sleep 0.1; printf A >> effects'); await Promise.all([f.run('printf a1'), { then(r) { r(1); } }]); await f.run('printf Q >> effects'); };
  const b = async () => { await f.run('sleep 15; printf B >> effects'); await f.run('printf L >> effects'); };
  await Promise.all([a(), b()]);`, { okIf: r => r.code !== 0 && !/[QLZ]/.test(r.effects) && r.ms < 10000 });

// ---- Secrets: granted step admitted only on resume, inside a parallel branch.
const SEC8 = `
  const g = async () => { await f.run('sleep 0.1; printf G'); await f.run('test -f release || { touch stalled; sleep 120; }; printf Y >> effects', { timeout: '5m' }); await f.run('printf "%s" "\${R7_TOK:-unset}" > <dir>/granted2', { secrets: ['R7_TOK'] }); };
  const u = async () => { await f.run('sleep 0.15; printf U'); await f.run('sleep 0.3; printf "%s" "\${R7_TOK:-unset}" > <dir>/ungranted2'); };
  await Promise.all([g(), u()]);
  await f.run('printf "%s" "\${R7_TOK:-unset}" > <dir>/later');`;
const sec8Check = root => {
  const fs = require('fs');
  const rd = n => { try { return fs.readFileSync(root + '/' + n, 'utf8'); } catch { return 'missing'; } };
  const cls = (n, want) => { const v = rd(n); return `${n}:${v === 'r7-secret-value' ? (want ? 'ok' : 'LEAK') : v}`; };
  return { sec: [cls('granted2', true), cls('ungranted2', false), cls('later', false)].join(' ') };
};
add({ name: 'SEC8m', env: { R7_TOK: 'r7-secret-value', RELAY_SECRET_ENV_NAMES: '["R7_TOK"]' }, extraCheck: sec8Check, files: { 'chain.flow.ts': flowSrc('sec8m', SEC8) },
  okIf: r => r.code === 0 && r.sec === 'granted2:ok ungranted2:unset later:unset' && perm('YZ')(r.effects) });

export default S;
