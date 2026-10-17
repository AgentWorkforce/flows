// Review-7 new attack scenarios for flows#667 (head e3503c08).
import { SURF, flowSrc, NAT, W2, TAIL5 } from './s.mjs';
const HS = [['head', 'head'], ['base', 'base']];
const S = [];
const add = (s) => S.push({ sides: HS, ...s });
const STALL = `  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });`;
const perm = (letters) => (e) => e.length === letters.length && [...letters].every(c => e.split(c).length - 1 === letters.split(c).length - 1);

// ---- HY: the instrumentation re-evaluates the body with a parameter named
// __certifyParallelBranch; an authored binding of that name captures it.
add({ name: 'HY1', files: { 'chain.flow.ts': flowSrc('hy1', `
  const __certifyParallelBranch = async () => { await f.run('printf P >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B >> effects'); };
  await Promise.all([__certifyParallelBranch(), b()]);`) },
  expect: r => perm('PBZ')(r.effects) });
add({ name: 'HY1s', files: { 'chain.flow.ts': `${SURF}
export default flow('hy1s', async f => {
  const __certifyParallelBranch = async () => { await f.run('printf P >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B >> effects'); };
  await Promise.all([__certifyParallelBranch(), b()]);
  f.done('success');
});
` }, noZ: true, okIf: r => r.code === 0 && perm('PB')(r.effects) });
add({ name: 'HY2', files: { 'chain.flow.ts': flowSrc('hy2', `
  const __certifyParallelBranch = await f.run('printf V');
  const a = async () => { await f.run('sleep 0.2; printf A >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B >> effects'); };
  await Promise.all([a(), b()]);`) }, expect: r => perm('ABZ')(r.effects) });

// ---- PAR: parenthesized branch-call members pass the grammar (unwrap) but
// the call-site instrumentation only wraps bare CallExpressions.
add({ name: 'PAR1', files: { 'chain.flow.ts': flowSrc('par1', `
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([(a()), (b()), (c())]);`) }, expect: r => perm('abcZ')(r.effects) });
add({ name: 'PAR2', files: { 'chain.flow.ts': flowSrc('par2', `
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  await Promise.all([((async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); })()), b()]);`) },
  expect: r => perm('abZ')(r.effects) });

// ---- EQ: certified shapes whose runtime behaviour must match base.
add({ name: 'EQ1twice', files: { 'chain.flow.ts': flowSrc('eq1', `
  const a = async () => { await f.run('sleep 0.2; printf A'); await f.run('printf a >> effects'); };
  await Promise.all([a(), a()]);
  await f.run('printf X >> effects');`) }, allowDupLetters: true,
  expectedCounts: { 'sleep 0.2; printf A': 2, 'printf a >> effects': 2 }, expect: r => r.effects === 'aaXZ' });
add({ name: 'EQ2ret', files: { 'chain.flow.ts': flowSrc('eq2', `
  const a = async () => { await f.run('sleep 0.3; printf A'); return await f.run('printf a'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); return await f.run('printf b'); };
  const r = await Promise.all([a(), b()]);
  await f.run('printf ' + r[0] + r[1] + ' >> effects');`) }, expect: r => r.effects === 'abZ' });
add({ name: 'EQ3midret', files: { 'chain.flow.ts': flowSrc('eq3', `
  const a = async () => { await f.run('sleep 0.2; printf A >> effects'); return await f.run('printf R >> effects'); await f.run('printf Q >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B >> effects'); };
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`) }, expect: r => perm('ABRXZ')(r.effects) && !r.effects.includes('Q') });
add({ name: 'EQ4fail', files: { 'chain.flow.ts': flowSrc('eq4', `
  const a = async () => { await f.run('sleep 0.1; printf F >> effects; exit 1'); await f.run('printf G >> effects'); };
  const b = async () => { await f.run('sleep 0.4; printf B >> effects'); await f.run('printf C >> effects'); };
  await Promise.all([a(), b()]);`) }, okIf: r => r.code !== 0 && !r.effects.includes('G') && !r.effects.includes('C') && !r.effects.includes('Z') });
add({ name: 'EQ5wide', files: { 'chain.flow.ts': flowSrc('eq5', `
  ${Array.from({ length: 12 }, (_, i) => `const b${i} = async () => { await f.run('sleep 0.${1 + (i * 7) % 3}; printf S${i}'); await f.run('printf ${'abcdefghijkl'[i]} >> effects'); };`).join('\n  ')}
  await Promise.all([${Array.from({ length: 12 }, (_, i) => `b${i}()`).join(', ')}]);
  await f.run('printf X >> effects');`) }, expect: r => perm('abcdefghijklXZ')(r.effects) });
add({ name: 'EQ5stall', files: { 'chain.flow.ts': flowSrc('eq5s', `
  ${Array.from({ length: 10 }, (_, i) => `const b${i} = async () => { await f.run('sleep 0.${1 + (i * 7) % 3}; printf S${i}'); await f.run('printf ${'abcdefghij'[i]} >> effects'); };`).join('\n  ')}
  const s = async () => { await f.run('sleep 0.15; printf s'); await f.run('test -f release || { touch stalled; sleep 120; }; printf Y >> effects', { timeout: '5m' }); await f.run('printf y >> effects'); };
  await Promise.all([${Array.from({ length: 10 }, (_, i) => `b${i}()`).join(', ')}, s()]);
  await f.run('printf X >> effects');`) }, expect: r => perm('abcdefghijYyXZ')(r.effects) });
add({ name: 'EQ6expr', files: { 'chain.flow.ts': flowSrc('eq6', `
  const a = async () => await f.run('sleep 0.2; printf A >> effects');
  const b = async () => await Promise.all([f.run('sleep 0.1; printf B >> effects'), f.run('sleep 0.3; printf C >> effects')]);
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`) }, expect: r => perm('ABCXZ')(r.effects) });
add({ name: 'EQ7record', files: { 'chain.flow.ts': flowSrc('eq7', `
  const a = async () => { const r = await f.run('sleep 0.2; exit 3', { onNonZero: 'record' }); await f.run('printf R' + r.exitCode + ' >> effects'); };
  const b = async () => { const v = await f.run('sleep 0.1; printf B'); await f.run('printf ' + v + ' >> effects'); };
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`) }, expect: r => r.effects.includes('R3') && perm('BR3XZ')(r.effects) });
add({ name: 'EQ8throw', files: { 'chain.flow.ts': flowSrc('eq8', `
  const x = await f.run('printf W');
  const a = async () => { await f.run('printf ' + x.y.z + ' >> effects'); };
  const b = async () => { await f.run('sleep 0.2; printf B >> effects'); await f.run('printf C >> effects'); };
  await Promise.all([a(), b()]);`) }, okIf: r => r.code !== 0 && !r.effects.includes('Z') });
// Branch whose first statement is a nested group, then a follow-up that joins
// the nested members; crash lands inside the other branch.
add({ name: 'EQ9nested', files: { 'chain.flow.ts': flowSrc('eq9', `
  await f.run('sleep 0.1; printf W');
  const a = async () => { await Promise.all([f.run('sleep 0.3; printf A1'), f.run('sleep 0.1; printf A2')]); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.2; printf B'); await f.run('test -f release || { touch stalled; sleep 120; }; printf Y >> effects', { timeout: '5m' }); await f.run('printf b >> effects'); };
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`) }, expect: r => perm('aYbXZ')(r.effects) });

// ---- PL: NODE_OPTIONS preloads. The entry is certified; the patch runs
// before the SDK snapshots the intrinsics, so the snapshot accepts it.
const R5PATCH = `const I = Function('return this')()['Pro' + 'mise'];
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
const NATW = flowSrc('pl', `
  await f.run('sleep 0.2; printf W');
${NAT}  await f.run('printf X >> effects');`);
const pl = (name, patch, extra = {}) => add({ name, env: { NODE_OPTIONS: `--import=<dir>/lib/pre.mjs` },
  files: { 'chain.flow.ts': NATW.replace("flow('pl'", `flow('${name.toLowerCase()}'`), 'lib/pre.mjs': patch }, expect: r => perm('abcXZ')(r.effects), ...extra });
pl('PL1r5', R5PATCH);
pl('PL2then', `const t = Promise.prototype.then;
Promise.prototype.then = function then(a, b) { return t.call(this, typeof a === 'function' ? v => a(v) : a, typeof b === 'function' ? e => b(e) : b); };
`);
pl('PL3sub', `const N = globalThis.Promise;
class P extends N {}
globalThis.Promise = P;
`);
pl('PL4ctor', `setTimeout(() => {
  const N = globalThis.Promise;
  class P extends N {}
  Object.defineProperty(N.prototype, 'constructor', { value: P, writable: true, configurable: true });
}, 120).unref();
`);
pl('PL5species', `setTimeout(() => {
  const N = globalThis.Promise;
  class P extends N {}
  Object.defineProperty(N, Symbol.species, { get() { return P; }, configurable: true });
}, 120).unref();
`);

// ---- secrets in parallel branches (granted / ungranted / later)
const SEC = `
  const g = async () => { await f.run('sleep 0.1; printf G'); await f.run('printf "%s" "\${R7_TOK:-unset}" > <dir>/granted2; sleep 0.1', { secrets: ['R7_TOK'] }); };
  const u = async () => { await f.run('sleep 0.15; printf U'); await f.run('printf "%s" "\${R7_TOK:-unset}" > <dir>/ungranted2'); };
  await Promise.all([
    f.run('printf "%s" "\${R7_TOK:-unset}" > <dir>/granted; sleep 0.2', { secrets: ['R7_TOK'] }),
    f.run('printf "%s" "\${R7_TOK:-unset}" > <dir>/ungranted; sleep 0.1'),
    g(), u(),
  ]);
  await f.run('printf "%s" "\${R7_TOK:-unset}" > <dir>/later');`;
const secCheck = root => {
  const fs = require('fs');
  const rd = n => { try { return fs.readFileSync(root + '/' + n, 'utf8'); } catch { return 'missing'; } };
  const cls = (n, want) => { const v = rd(n); return `${n}:${v === 'r7-secret-value' ? (want ? 'ok' : 'LEAK') : v}`; };
  return { sec: [cls('granted', true), cls('granted2', true), cls('ungranted', false), cls('ungranted2', false), cls('later', false)].join(' ') };
};
add({ name: 'SEC7', env: { R7_TOK: 'r7-secret-value' }, extraCheck: secCheck, noZ: false, files: { 'chain.flow.ts': flowSrc('sec7', SEC) },
  okIf: r => r.code === 0 && r.sec === 'granted:ok granted2:ok ungranted:unset ungranted2:unset later:unset' });

add({ name: 'PL7mid', env: { NODE_OPTIONS: `--import=<dir>/lib/pre.mjs` }, expect: r => perm('abcXZ')(r.effects),
  files: { 'chain.flow.ts': flowSrc('pl7', `
  await f.run('touch <dir>/wstart; sleep 0.3; printf W');
${NAT}  await f.run('printf X >> effects');`),
  'lib/pre.mjs': `import fs from 'node:fs';
const t = setInterval(() => { if (fs.existsSync('<dir>/wstart')) { clearInterval(t);
${R5PATCH}} }, 2);
t.unref();
` } });
add({ name: 'PL7neutral', env: { NODE_OPTIONS: `--import=<dir>/lib/pre.mjs` }, expect: r => perm('abcXZ')(r.effects),
  files: { 'chain.flow.ts': flowSrc('pl7n', `
  await f.run('touch <dir>/wstart; sleep 0.3; printf W');
${NAT}  await f.run('printf X >> effects');`),
  'lib/pre.mjs': `import fs from 'node:fs';
const t = setInterval(() => { if (fs.existsSync('<dir>/wstart')) { clearInterval(t);
  const I = globalThis.Promise; const resolve = I.resolve; I.resolve = function resolve2(x) { return resolve.call(this, x); };
} }, 2);
t.unref();
` } });
pl('PL6child', `if (process.argv.some(a => a.includes('authored-node-entry'))) setTimeout(() => {\n${R5PATCH}}, 150).unref();\n`);
pl('PL6late', `setTimeout(() => {\n${R5PATCH}}, 150).unref();\n`);
add({ name: 'SEC7m', env: { R7_TOK: 'r7-secret-value', RELAY_SECRET_ENV_NAMES: '["R7_TOK"]' }, extraCheck: secCheck, files: { 'chain.flow.ts': flowSrc('sec7m', SEC) },
  okIf: r => r.code === 0 && r.sec === 'granted:ok granted2:ok ungranted:unset ungranted2:unset later:unset' });
add({ name: 'SEC7miss', env: { RELAY_SECRET_ENV_NAMES: '["R7_TOK"]' }, extraCheck: secCheck, files: { 'chain.flow.ts': flowSrc('sec7x', SEC) },
  okIf: r => r.code !== 0 && !/granted:/.test('') });

export default S;
