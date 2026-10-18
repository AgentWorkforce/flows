// Review-676 scenarios for flows#676 (head 64e7f9c2): hosted standalone (Bun parent + embedded Node child).
// Run with h676.mjs. Sides: sah = standalone head, sa52 = shipped 2.0.52 standalone, head = npm/Node head.
import { SURF, flowSrc, NAT, W2 } from './s.mjs';
const N2 = `
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('sleep 0.1; printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);`;
const S3 = process.env.MAC676 ? [['sah', 'sah'], ['nb', 'nb'], ['sa52', 'sa52']] : [['sah', 'sah'], ['head', 'head'], ['sa52', 'sa52']];
const SA = [['sah', 'sah'], ['sa52', 'sa52']];
const S = [];
const add = (s) => S.push({ sides: S3, ...s });
const perm = (letters) => (e) => e.length === letters.length && [...letters].every(c => e.split(c).length - 1 === letters.split(c).length - 1);
const ok5 = r => perm('abcXZ')(r.effects);
const STALLCMD = `await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });`;
const NATW = (name, param = 'f') => `${SURF}
export default flow('${name}', async ${param} => {
${W2}${NAT}  await f.run('printf X >> effects');
  ${STALLCMD}
  f.done('success');
});
`;

// ---- 1. TypeScript-annotated certified shapes: Bun certifies from the TS source, npm compares
// against Node's type-stripped toString (annotations become spaces), so the routes differ.
add({ name: 'TS1param', files: { 'chain.flow.ts': NATW('ts1', '(f: any)') }, expect: ok5 });
add({ name: 'TS2annot', files: { 'chain.flow.ts': `${SURF}
export default flow('ts2', async f => {
  const w: string = await f.run('sleep 0.2; printf W');
${NAT}  await f.run('printf X >> effects');
  ${STALLCMD}
  f.done('success');
});
` }, expect: ok5 });
add({ name: 'TS3ret', files: { 'chain.flow.ts': `${SURF}
export default flow('ts3', async f => {
${W2}  const a = async (): Promise<void> => { await f.run('sleep 0.4; printf A'); await f.run('printf a >> effects'); };
  const b = async (): Promise<void> => { await f.run('printf B'); await f.run('printf b >> effects'); };
  const c = async (): Promise<void> => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');
  ${STALLCMD}
  f.done('success');
});
` }, expect: ok5 });

// ---- 2. Body substitution by the installed Surface (pinned by hash, not by authenticity).
// The certified .flow.ts writes abcXZ; the Surface's flow() registers a different parallel-shaped body
// that writes pqXZ. npm compares the executed body with the source (serial); the Bun parent never looks
// at the body and the Node child checks only its grammar.
const OTHER = `async f => {
  await f.run('sleep 0.2; printf W');
  const p = async () => { await f.run('sleep 0.3; printf P'); await f.run('printf p >> effects'); };
  const q = async () => { await f.run('printf Q'); await f.run('printf q >> effects'); };
  await Promise.all([p(), q()]);
  await f.run('printf X >> effects');
  ${STALLCMD}
  f.done('success');
}`;
const shimPkg = { name: '@relayflows/surface', version: '2.0.52', private: true, type: 'module', exports: { '.': './index.js', './runtime': './runtime.js' } };
const shim = (index) => ({
  'node_modules/@relayflows/surface/package.json': JSON.stringify(shimPkg),
  'node_modules/@relayflows/surface/index.js': index,
  'node_modules/@relayflows/surface/runtime.js': `export { getFlowDefinition } from '<nm>/@relayflows/surface/dist/flow.js';\n`,
});
add({ name: 'SUB1', realNodeModules: true, files: { 'chain.flow.ts': NATW('sub1'), ...shim(`export * from '<nm>/@relayflows/surface/dist/index.js';
import { flow as realFlow } from '<nm>/@relayflows/surface/dist/index.js';
export function flow(name, _body) { return realFlow(name, ${OTHER}); }
`) }, expect: r => perm('pqXZ')(r.effects) });

// ---- 3. Child-only import-time patch (contrived): the Surface patches the Array iterator only under Node.
// npm sees it at admission (serial, completes); the Bun parent cannot see it (parallel); the child's
// pre-body intrinsic check then fails the root before any child.
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
add({ name: 'CP1', realNodeModules: true, files: { 'chain.flow.ts': NATW('cp1'), ...shim(`if (!process.versions.bun) {\n${ITER}}\nexport * from '<nm>/@relayflows/surface/dist/index.js';\n`) }, expect: ok5 });

// ---- 4. TOCTOU: replace the .flow.ts after the Bun parent hashed/admitted it and before the Node child loads it.
// FLOWS_AUTHORED_NODE is a wrapper; its 2nd invocation is runAuthoredInNode's probe (after admission).
const WRAP = `#!/bin/sh
n=$(cat <dir>/probes 2>/dev/null || echo 0); n=$((n+1)); echo $n > <dir>/probes
if [ "$n" = "\${SWAP_AT:-2}" ] && [ ! -f <dir>/swapped ]; then cp <dir>/lib/evil.flow.ts <dir>/chain.flow.ts; touch <dir>/swapped; fi
exec "\${REAL_NODE:-/usr/local/bin/node}" "$@"
`;
const EVIL = `${SURF}
export default flow('toc1', async f => {
  const e = async () => { await f.run('printf E >> effects'); };
  const v = async () => { await f.run('printf V >> effects'); };
  await Promise.all([e(), v()]);
  ${STALLCMD}
  f.done('success');
});
`;
S.push({ name: 'TOC1', sides: SA, env: { FLOWS_AUTHORED_NODE: '<dir>/lib/node-wrap.sh', REAL_NODE: process.env.REAL_NODE ?? '/usr/local/bin/node' },
  files: { 'chain.flow.ts': NATW('toc1'), 'lib/evil.flow.ts': EVIL, 'lib/node-wrap.sh': WRAP },
  okIf: r => r.fresh && r.code !== 0 && !/[EV]/.test(r.effects) });

// ---- 5. Symlinked entry: chain.flow.ts -> impl.ts (target not *.flow.ts) and -> real.flow.ts.
add({ name: 'SYM1', symlinks: { 'chain.flow.ts': 'impl.ts' }, files: { 'impl.ts': NATW('sym1') }, expect: ok5 });
add({ name: 'SYM2', symlinks: { 'chain.flow.ts': 'real.flow.ts' }, files: { 'real.flow.ts': NATW('sym2') }, expect: ok5 });

// ---- 6. Forged result claims. The Surface wraps JSON.stringify in the Node child only, so the
// authenticated IPC result frame carries a mutated journalSteps claim. The durable journal is untouched.
const FORGES = {
  none: 'void s;',
  reorder: 'const t = s.pop(); s.reverse(); s.push(t);',
  drop: 's.splice(0, 1);',
  swap: 'const r0 = s[0].runId; s[0] = { ...s[0], runId: s[1].runId }; s[1] = { ...s[1], runId: r0 };',
  fakeid: "s[1] = { ...s[1], id: 'run-after-' + 'a'.repeat(64) + '-1' };",
  reason: "s[1] = { ...s[1], completionReason: 'timeout' };",
  dupe: 's[1] = { ...s[0] };',
  serialids: "for (let i = 0; i < s.length - 1; i++) s[i] = { ...s[i], id: 'run-' + (i + 1) };",
  terminal: "m.result.completionReason = 'failure';",
  gate: "s.splice(s.length - 1, 0, { id: s[0].id + '.gate', runId: s[0].runId, completionReason: 'success' });",
  edges: "for (let i = 0; i < s.length - 1; i++) s[i] = { ...s[i], after: ['forged-step'] };",
};
for (const [n, mutate] of Object.entries(FORGES)) {
  S.push({ name: `FG_${n}`, sides: SA, realNodeModules: true, files: { 'release': '', 'chain.flow.ts': NATW(`fg-${n}`), ...shim(`if (!process.versions.bun) {
  const stringify = JSON.stringify;
  JSON.stringify = function (v, ...rest) {
    if (v && v.type === 'result' && Array.isArray(v.result?.journalSteps)) {
      const m = structuredClone(v); const s = m.result.journalSteps; ${mutate}
      require_log(m); return stringify.call(this, m, ...rest);
    }
    return stringify.call(this, v, ...rest);
  };
  const { appendFileSync } = await import('node:fs');
  function require_log(m) { appendFileSync('<dir>/forged', stringify(m.result.journalSteps.map(x => x.id + '|' + x.runId.slice(-6) + '|' + x.completionReason)) + '\\n'); }
}
export * from '<nm>/@relayflows/surface/dist/index.js';
`) }, okIf: n === 'none' || n === 'reorder' || n === 'edges' ? (r => r.code === 0 && ok5(r)) : (r => r.code !== 0 && ok5(r)) });
}

// ---- 7. Kill windows inside the parallel group (not only at the stall marker).
add({ name: 'KM1', files: { 'chain.flow.ts': `${SURF}
export default flow('km1', async f => {
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('sleep 0.1; printf a >> effects'); };
  const b = async () => { await f.run('test -f release || touch stalled; sleep 0.6; printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('sleep 0.2; printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');
  await f.run('printf Z >> effects');
  f.done('success');
});
` }, expect: ok5 });
const POLLSTALL = `await f.run('test -f release || { touch stalled; i=0; while [ ! -f release ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; }; printf Z >> effects', { timeout: '5m' });`;
add({ name: 'KD1', keepDaemon: true, files: { 'chain.flow.ts': NATW('kd1').replace(STALLCMD, POLLSTALL) }, expect: ok5 });
add({ name: 'KD2', keepDaemon: true, files: { 'chain.flow.ts': `${SURF}
export default flow('kd2', async f => {
  const a = async () => { await f.run('sleep 0.3; printf A'); await f.run('sleep 0.1; printf a >> effects'); };
  const b = async () => { await f.run('test -f release || touch stalled; sleep 0.6; printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('sleep 0.2; printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');
  await f.run('printf Z >> effects');
  f.done('success');
});
` }, expect: ok5 });

// ---- 8. Upgrade (2.0.52 standalone root resumed by head standalone) and rollback (head root resumed by 2.0.52).
for (const [n, src, ok] of [['NATW', NATW('upn'), ok5], ['N2', flowSrc('upn2', N2), r => perm('abcZ')(r.effects)]]) {
  S.push({ name: `UP_${n}`, sides: [['sa52', 'sah']], files: { 'chain.flow.ts': src }, expect: ok });
  S.push({ name: `RB_${n}`, sides: [['sah', 'sa52']], secondResume: 'sah', files: { 'chain.flow.ts': src },
    okIf: r => ok(r) && r.code === 0 });
}

// ---- 9. Embedded runner on Node 22.16.0 (the evidence's version) instead of PATH node.
S.push({ name: 'N2216', sides: [['sah', 'sah']], env: { FLOWS_AUTHORED_NODE: '/w/node2216/bin/node' }, files: { 'chain.flow.ts': NATW('n2216') }, expect: ok5 });

// ---- 10. Revert-proof fixture for the child-side module recheck: a module-level Promise binding
// (never certified) admitted parallel only by a forced Bun parent (mutants sam3 / sam4).
S.push({ name: 'FP1', sides: [['sam3', 'sam3'], ['sam4', 'sam4'], ['sah', 'sah']], files: { 'chain.flow.ts': NATW('fp1').replace(`${SURF}\n`, `${SURF}\nconst Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };\n`) }, expect: ok5 });

export default S;
