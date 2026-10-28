// Review-6 attack scenarios.
import { STALL, SURF, flowSrc, HS, P_BIND, G3, NAT, TAIL5, W2, impl } from './s.mjs';
const S = [];
const add = (s) => S.push({ sides: HS, ...s });
const FORCED = [['forced', 'forced'], ['base', 'base']];

// ---------- entry-file rule bypass (natural, unforced) ----------
// The entry defines `flow` locally; the screen sees `export default flow(<arrow>)`,
// but the loaded definition is impl.ts's, whose module scope binds Promise.
const BYPASS = `import impl from './impl.ts';
const flow = (..._args: unknown[]) => impl;
export default flow('decoy', async f => {
  await f.run('printf decoy');
});
`;
// A spec-exact Promise.all built only from registered combinators; its one
// unregistered join is a *member* of a registered all.
const P_WRAP = `const Promise = { all: (xs) => globalThis.Promise.all([new globalThis.Promise((res, rej) => { const out = []; let n = xs.length; xs.forEach((x, i) => globalThis.Promise.all([x]).then(([v]) => { out[i] = v; if (--n === 0) res(out); }, rej)); })]).then(([v]) => v) };`;
const P_RACE = `const Promise = { all: (xs) => globalThis.Promise.race(xs) };`;
add({ name: 'R1', files: { 'chain.flow.ts': BYPASS, 'impl.ts': impl('r1', P_WRAP, G3) } });
add({ name: 'R1w', files: { 'chain.flow.ts': BYPASS, 'impl.ts': impl('r1w', P_WRAP, W2 + G3) } });
add({ name: 'R1wn', files: { 'chain.flow.ts': BYPASS, 'impl.ts': impl('r1wn', P_WRAP, W2 + NAT) } });
add({ name: 'R2w', files: { 'chain.flow.ts': BYPASS, 'impl.ts': impl('r2w', P_RACE, W2 + G3) } });
add({ name: 'R3w', files: { 'chain.flow.ts': BYPASS, 'impl.ts': impl('r3w', P_BIND, W2 + G3) } });
add({ name: 'R3', files: { 'chain.flow.ts': BYPASS, 'impl.ts': impl('r3', P_BIND, G3) } });
// same bypass, `flow` imported from a local helper module
add({ name: 'R4w', files: {
  'chain.flow.ts': `import { flow } from './wrap.ts';
export default flow('decoy', async f => {
  await f.run('printf decoy');
});
`,
  'wrap.ts': `import impl from './impl.ts';\nexport const flow = (..._args: unknown[]) => impl;\n`,
  'impl.ts': impl('r4w', P_WRAP, W2 + G3) } });
// Without the bypass the wrapped all is serial (control)
add({ name: 'R1c', files: { 'chain.flow.ts': `${SURF}\n${P_WRAP}\nexport default flow('r1c', async f => {\n${W2}${G3}${TAIL5}` } });

// ---------- runtime rule with eligibility forced on ----------
const forced = (name, body, pre = '') => ({ name, sides: FORCED, files: { 'chain.flow.ts': flowSrc(name.toLowerCase(), body, { pre }) } });
S.push(forced('FRrace', `
  await f.run('sleep 0.2; printf W');
  await Promise.race([f.run('sleep 0.3; printf A'), f.run('sleep 0.1; printf B')]);
  await f.run('printf X >> effects');`));
S.push(forced('FRany', `
  await f.run('sleep 0.2; printf W');
  await Promise.any([f.run('sleep 0.3; printf A'), f.run('sleep 0.1; printf B')]);
  await f.run('printf X >> effects');`));
S.push(forced('FRnestrace', `
  await f.run('sleep 0.2; printf W');
  await Promise.all([Promise.race([f.run('sleep 0.3; printf A'), f.run('sleep 0.1; printf B')]), f.run('printf C')]);
  await f.run('printf X >> effects');`));
S.push(forced('FRdefer', `
  await f.run('sleep 0.2; printf W');
  let signal; const first = new Promise(r => { signal = r; });
  const a = async () => { await f.run('sleep 0.3; printf A >> effects'); signal(); };
  const b = async () => { await f.run('sleep 0.1; printf B >> effects'); signal(); };
  const c = async () => { await Promise.all([first, f.run('printf c0')]); await f.run('printf C >> effects'); };
  await Promise.all([a(), b(), c()]);`));
S.push(forced('FRthen', `
  await f.run('sleep 0.2; printf W');
  const sa = f.run('sleep 0.3; printf A');
  const th = { then: (r, j) => sa.then(r, j) };
  await Promise.all([th, f.run('sleep 0.1; printf B')]);
  await f.run('printf X >> effects');`));
S.push(forced('FRsettled', `
  await f.run('sleep 0.2; printf W');
  await Promise.allSettled([f.run('sleep 0.3; exit 3', { onNonZero: 'record' }), f.run('sleep 0.1; printf B')]);
  await f.run('printf X >> effects');`));
S.push(forced('FRset', `
  await f.run('sleep 0.2; printf W');
  await Promise.all(new Set([f.run('sleep 0.3; printf A'), f.run('sleep 0.1; printf B')]));
  await f.run('printf X >> effects');`));
S.push(forced('FRgen', `
  await f.run('sleep 0.2; printf W');
  function* g() { yield f.run('sleep 0.3; printf A'); yield f.run('sleep 0.1; printf B'); }
  await Promise.all(g());
  await f.run('printf X >> effects');`));
S.push(forced('FRthenagg', `
  await f.run('sleep 0.2; printf W');
  await Promise.all([f.run('sleep 0.3; printf A'), f.run('sleep 0.1; printf B')]).then(v => v);
  await f.run('printf X >> effects');`));
S.push(forced('FRmicro', `
  await f.run('sleep 0.2; printf W');
  const a = async () => { await f.run('sleep 0.3; printf A'); await new Promise(r => queueMicrotask(r)); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await new Promise(r => process.nextTick(r)); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await new Promise(r => setImmediate(r)); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');`));
S.push(forced('FRcatch', `
  await f.run('sleep 0.2; printf W');
  const a = async () => { await f.run('sleep 0.1; printf A'); throw new Error('a'); };
  const b = async () => { await f.run('sleep 0.3; printf B'); throw new Error('b'); };
  try { await Promise.all([a(), b()]); } catch (e) { void e; }
  await f.run('sleep 0.5; printf X >> effects');`));
S.push(forced('FRfinally', `
  await f.run('sleep 0.2; printf W');
  const a = async () => { try { await f.run('sleep 0.3; printf A'); } finally { await f.run('printf F >> effects'); } };
  const b = async () => { await f.run('sleep 0.1; printf B'); };
  await Promise.all([a(), b()]);
  await f.run('printf X >> effects');`));
S.push(forced('FRiter', `
  await f.run('sleep 0.2; printf W');
  const ps = [f.run('sleep 0.3; printf A'), f.run('sleep 0.1; printf B')];
  for await (const v of ps) { void v; }
  await f.run('printf X >> effects');`));
// forced wrapped-all directly in the entry (no bypass needed)
S.push({ name: 'FRwrap', sides: FORCED, files: { 'chain.flow.ts': `${SURF}\n${`const PW = ${P_WRAP.slice('const Promise = '.length).replace(/;$/, '')};`}\nexport default flow('frwrap', async f => {\n${W2}  await PW.all([f.run('sleep 0.5; printf A'), f.run('printf B'), f.run('sleep 0.1; printf C')]);\n${TAIL5}` } });

// ---------- entry-file rule probes (natural) ----------
add({ name: 'E1factory', files: { 'chain.flow.ts': `${SURF}
const make = () => flow('e1', async f => {
${NAT}${TAIL5}export default make();
` } });
add({ name: 'E2helper', files: {
  'chain.flow.ts': flowSrc('e2', `
  const a = async () => { await f.run('sleep 0.3; printf A'); await pause(); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  await Promise.all([a(), b()]);`, { pre: `import { pause } from './helper.ts';\n` }),
  'helper.ts': `export const pause = async () => { await new Promise(r => setTimeout(r, 50)); };\n` } });
add({ name: 'E3dyn', files: {
  'chain.flow.ts': flowSrc('e3', `
  const a = async () => { await f.run('sleep 0.3; printf A'); await import('./helper.ts'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  await Promise.all([a(), b()]);`),
  'helper.ts': `export const x = 1;\n` } });
add({ name: 'E4json', files: {
  'chain.flow.ts': flowSrc('e4', N2body(), { pre: `import data from './d.json' with { type: 'json' };\nvoid data;\n` }),
  'd.json': `{"k":"v"}` } });
add({ name: 'E4jsonuse', files: {
  'chain.flow.ts': flowSrc('e4u', `
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf ' + data.k + ' >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  await Promise.all([a(), b()]);`, { pre: `import data from './d.json' with { type: 'json' };\n` }),
  'd.json': `{"k":"a"}` } });
add({ name: 'E5ns', files: { 'chain.flow.ts': `${SURF}
import * as surface from '@relayflows/surface';
export default surface.flow('e5', async f => {
${NAT}${TAIL5}` } });
function N2body() { return `
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);`; }

// ---------- upgrade / rollback ----------
const UP = [['p2050', 'head'], ['p2051', 'head']];
const CI4 = flowSrc('ci4', `
  await f.run('printf a >> effects');
  await Promise.resolve(f.run('printf b >> effects'));
  await Promise.all([f.run('printf c >> effects'), f.run('printf d >> effects')]);
  await f.run('test -f release || { touch stalled; sleep 120; }; printf y >> effects', { timeout: '5m' });
  await Promise.all([Promise.resolve(f.run('printf e >> effects')), Promise.resolve(f.run('printf g >> effects'))]);`);
const CI5 = flowSrc('ci5', `
  await f.run('printf a >> effects');
  await Promise.resolve(f.run('printf b >> effects'));
  await Promise.all([f.run('printf c >> effects'), f.run('printf d >> effects')]);
  await f.run('printf e >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf y >> effects', { timeout: '5m' });
  await Promise.all([Promise.resolve(f.run('printf g >> effects')), Promise.resolve(f.run('printf h >> effects'))]);`);
const A1b = `
  const left = async () => {
    await Promise.all([f.run('sleep 0.3; printf A'), f.run('printf B')]);
    await f.run('printf L >> effects');
  };
  const right = async () => {
    await Promise.all([f.run('printf C'), f.run('sleep 0.3; printf D')]);
    await f.run('printf R >> effects');
  };
  await Promise.all([left(), right()]);`;
const B1b = `
  const left = async () => { await f.run('printf A'); await f.run('printf B'); await f.run('printf L >> effects'); };
  const right = async () => { await Promise.all([f.run('printf C'), f.run('printf D')]); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);`;
for (const [n, src] of [['CI4', CI4], ['CI5', CI5], ['A1', flowSrc('a1', A1b)], ['B1', flowSrc('b1', B1b)], ['N2', flowSrc('n2', N2body())]]) {
  S.push({ name: 'U' + n, sides: UP, files: { 'chain.flow.ts': src } });
  S.push({ name: 'RB' + n, sides: [['head', 'p2050'], ['head', 'p2051']], secondResume: 'head',
    expect: r => r.code1 !== 0 && !r.effects1.includes('Z') && r.effects.includes('Z'),
    files: { 'chain.flow.ts': src } });
}

export default S;
