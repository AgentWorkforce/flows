// Scenario definitions for review 6 of flows#667.
const STALL = `  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');`;
const SURF = `import { flow } from '@relayflows/surface';`;
const flowSrc = (name, body, { fnExpr = false, header = '', pre = '' } = {}) => `${SURF}
${pre}export default flow('${name}'${header}, ${fnExpr ? 'async function(f)' : 'async f =>'} {${body}
${STALL}
});
`;
const ADAPTER = `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
if (process.argv[2] === '--relayflows-adapter-v1') {
  process.stdout.write('relayflows-agent-cli-v1\\n');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (input.trim() === '') process.exit(0);
  const request = JSON.parse(input);
  if (request.protocol !== 'relayflows-agent-cli-v1') process.exit(2);
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  fs.appendFileSync('<dir>/calls', 'x');
  process.stdout.write('{"message":"ok"}');
}
`;
const HS = [['head', 'head'], ['base', 'base']];
const S = [];
const add = (s) => S.push({ sides: HS, ...s });

// ---- review-5 fixtures, verbatim ----
const P_BIND = `const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };`;
const P_HAND = `const Promise = { all: (xs) => new globalThis.Promise((res, rej) => { const out = []; let n = xs.length; xs.forEach((x, i) => globalThis.Promise.resolve(x).then(v => { out[i] = v; if (--n === 0) res(out); }, rej)); }) };`;
const CHAIN = `export { default } from './impl.ts';\n`;
const TAIL5 = `  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
`;
const G3 = `  await Promise.all([f.run('sleep 0.5; printf A'), f.run('printf B'), f.run('sleep 0.1; printf C')]);\n`;
const NAT = `  const a = async () => { await f.run('sleep 0.4; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);\n`;
const impl = (name, P, body) => `${SURF}\n${P}\nexport default flow('${name}', async f => {\n${body}${TAIL5}`;
const W2 = `  await f.run('sleep 0.2; printf W');\n`;
add({ name: 'Q5', files: { 'chain.flow.ts': CHAIN, 'impl.ts': impl('q5', P_BIND, G3) } });
add({ name: 'Q5n', files: { 'chain.flow.ts': CHAIN, 'impl.ts': impl('q5n', P_BIND, NAT) } });
add({ name: 'Q5h', files: { 'chain.flow.ts': CHAIN, 'impl.ts': impl('q5h', P_HAND, G3) } });
add({ name: 'Q5w', files: { 'chain.flow.ts': CHAIN, 'impl.ts': impl('q5w', P_BIND, W2 + G3) } });
add({ name: 'Q5wn', files: { 'chain.flow.ts': CHAIN, 'impl.ts': impl('q5wn', P_BIND, W2 + NAT) } });
add({ name: 'Q5wh', files: { 'chain.flow.ts': CHAIN, 'impl.ts': impl('q5wh', P_HAND, W2 + G3) } });
add({ name: 'Q6Pw', files: {
  'chain.flow.ts': `${SURF}\nimport './lib/patch.mjs';\nexport default flow('q6Pw', async f => {\n  await f.run('sleep 0.3; printf W');\n${NAT}${TAIL5}`,
  'lib/patch.mjs': `const I = Function('return this')()['Pro' + 'mise'];
const intrinsicAll = I.all;
const t = setInterval(() => { if (I.all !== intrinsicAll) { clearInterval(t); I.all = function all(xs) { return intrinsicAll.call(I, xs); }; } }, 2);
t.unref();
` } });

// ---- P-series (review 4) ----
add({ name: 'P1', files: { 'chain.flow.ts': `${SURF}\n${P_BIND}\nexport default flow('p1', async f => {\n${G3}${TAIL5}` } });
add({ name: 'P1h', files: { 'chain.flow.ts': `${SURF}\n${P_HAND}\nexport default flow('p1h', async f => {\n${G3}${TAIL5}` } });
add({ name: 'P1c', files: { 'chain.flow.ts': `${SURF}\nclass Promise extends globalThis.Promise { static all(xs) { return globalThis.Promise.all.call(globalThis.Promise, xs); } }\nexport default flow('p1c', async f => {\n${G3}${TAIL5}` } });
add({ name: 'P1n', files: { 'chain.flow.ts': `${SURF}\n${P_BIND}\nexport default flow('p1n', async f => {\n${NAT}${TAIL5}` } });
add({ name: 'P1bn', files: { 'chain.flow.ts': `${SURF}\nimport Promise from './bb/bluebird.js';\nexport default flow('p1bn', async f => {\n${NAT}${TAIL5}` }, bluebird: true });
add({ name: 'P2', files: { 'chain.flow.ts': flowSrc('p2', `
  const warm = async () => {};
  await Promise.all([warm(), warm()]);
  await f.run('printf X >> effects');`) } });

// ---- prior matrix ----
add({ name: 'A1', files: { 'chain.flow.ts': flowSrc('a1', `
  const left = async () => {
    await Promise.all([f.run('sleep 0.3; printf A'), f.run('printf B')]);
    await f.run('printf L >> effects');
  };
  const right = async () => {
    await Promise.all([f.run('printf C'), f.run('sleep 0.3; printf D')]);
    await f.run('printf R >> effects');
  };
  await Promise.all([left(), right()]);`) } });
add({ name: 'B1', files: { 'chain.flow.ts': flowSrc('b1', `
  const left = async () => {
    await f.run('printf A');
    await f.run('printf B');
    await f.run('printf L >> effects');
  };
  const right = async () => {
    await Promise.all([f.run('printf C'), f.run('printf D')]);
    await f.run('printf R >> effects');
  };
  await Promise.all([left(), right()]);`) } });
const N2 = `
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);`;
add({ name: 'N2', files: { 'chain.flow.ts': flowSrc('n2', N2) } });
add({ name: 'C1e', files: { 'chain.flow.ts': flowSrc('c1e', `
  const background = (async () => { await f.run('printf X >> effects'); })();
  await new Promise(resolve => setTimeout(resolve, 300));
  await f.run('printf Y >> effects');
  await background;`) } });
add({ name: 'G1', files: { 'chain.flow.ts': flowSrc('g1', `
  await Promise.race([f.run('printf A >> effects'), f.run('sleep 0.3; printf B >> effects')]);
  await f.run('printf G >> effects');`) } });
const LLM_OUT = `const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };`;
add({ name: 'H1', adapter: true, extraArgs: ['--local-agent'], files: { 'adapter.mjs': ADAPTER, 'chain.flow.ts': flowSrc('h1', `
  ${LLM_OUT}
  const left = async () => { await f.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);`) } });
add({ name: 'H2', adapter: true, extraArgs: ['--local-agent'], files: { 'adapter.mjs': ADAPTER, 'chain.flow.ts': flowSrc('h2', `
  const left = async () => { await f.agent('left', { task: 'left', model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.agent('right', { task: 'right', model: 'test-model' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);`) } });
add({ name: 'K4', adapter: true, extraArgs: ['--local-agent'], files: { 'adapter.mjs': ADAPTER, 'chain.flow.ts': flowSrc('k4', `
  const g = arguments[0];
  ${LLM_OUT}
  const left = async () => { await g.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await g.llm('right', { output, model: 'test-model' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);`, { fnExpr: true }) } });
add({ name: 'I1', files: {
  'child.flow.ts': `${SURF}
export default flow('child', async (f, input) => {
  await Promise.all([f.run('printf first'), f.run('printf second')]);
  await f.run('printf ' + input.token + ' >> effects');
  f.done('success');
});
`,
  'chain.flow.ts': flowSrc('i1', `
  const left = async () => { await f.dispatch('child', { token: 'x' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.dispatch('child', { token: 'y' }); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);`, { header: `, { use: ['./child.flow.ts'] }` }) } });
add({ name: 'K1', files: { 'chain.flow.ts': flowSrc('k1', `
  const pause = () => sleep(300);
  const late = async () => { await Promise.all([pause(), pause()]); await f.run('printf L >> effects'); };
  const fast = async () => { await f.run('sleep 0.2; printf A >> effects'); await f.run('sleep 0.2; printf B >> effects'); await f.run('printf C >> effects'); };
  await Promise.all([fast(), late()]);`, { pre: `import { setTimeout as sleep } from 'node:timers/promises';\n` }) } });
add({ name: 'K2b', files: { 'chain.flow.ts': flowSrc('k2b', `
  const a = async () => { await f.run('sleep 0.3; printf A >> effects'); signal(); };
  const b = async () => { await f.run('sleep 0.1; printf B >> effects'); signal(); };
  const c = async () => { await Promise.all([ready(), ready()]); await f.run('printf C >> effects'); };
  await Promise.all([a(), b(), c()]);`, { pre: `let signal; const first = new Promise(r => { signal = r; });\nconst ready = async () => { await first; };\n` }) } });
add({ name: 'K3', files: { 'chain.flow.ts': flowSrc('k3', `
  const out = [];
  const a = async () => { out.push(await f.run('sleep 0.3; printf a')); };
  const b = async () => { out.push(await f.run('sleep 0.1; printf b')); };
  await Promise.all([a(), b()]);
  await f.run('printf ' + out.join('') + ' >> effects');`) }, expect: r => /^(ab|ba)Z$/.test(r.effects) });
add({ name: 'K5b', files: { 'chain.flow.ts': flowSrc('k5b', `
  const tree = async (d) => { if (d === 0) return; await Promise.all([tree(d - 1), tree(d - 1)]); };
  await f.run('printf A >> effects');
  await tree(12);
  try { await f.run('printf B >> effects'); } catch (e) { void e; }`) }, expect: r => r.effects.includes('B') });
add({ name: 'K13b', files: { 'chain.flow.ts': `${SURF}
export default flow('k13b', async f => {
  const b = async () => { await f.run('sleep 0.4; printf B >> effects'); await f.run('printf C >> effects'); };
  const a = async () => { await f.run('sleep 0.1; printf A >> effects'); await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' }); f.done('success'); };
  await Promise.all([b(), a()]);
});
` } });

export default S;
export { STALL, SURF, flowSrc, ADAPTER, HS, P_BIND, P_HAND, CHAIN, TAIL5, G3, NAT, impl, W2, add };
