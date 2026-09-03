// P2-A: the interception must not change what Promise.all DOES, and must not
// retain promises created outside the flow body.
// Usage: node promise-all-semantics.mjs [distDir]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = process.argv[2] ?? 'dist';
const { AuthoredFlowLifecycle } = await import(`${REPO}/sdk/${DIST}/authored-flow-lifecycle.js`);

const nativeAll = Promise.all;
const lc = new AuthoredFlowLifecycle();
console.log(`${DIST} Promise.all patched during a flow: ${Promise.all !== nativeAll}`);
const show = async (label, fn) => {
  try { console.log(`  ${label} -> RESOLVED ${JSON.stringify(await fn())}`); }
  catch (e) { console.log(`  ${label} -> rejected: ${e.constructor.name}`); }
};
try { const p = Promise.all(null); p.catch(() => undefined); }
catch (e) { console.log(`  patched Promise.all(null) -> THREW SYNCHRONOUSLY: ${e.constructor.name}`); }
await show('patched Promise.all(null)  ', () => Promise.all(null));
await show('patched Promise.all(5)     ', () => Promise.all(5));
await show('patched Promise.all([1,P2])', () => Promise.all([1, Promise.resolve(2)]));
console.log(`  patched Promise.all.name=${JSON.stringify(Promise.all.name)} length=${Promise.all.length}`);

const tracked = () => {
  const sizes = [];
  const visit = (h) => { for (const v of Object.values(h)) {
    if (v instanceof Map || v instanceof Set) sizes.push(v.size);
    else if (typeof v === 'object' && v !== null && !Array.isArray(v)) visit(v);
  } };
  visit(lc); return sizes.reduce((a, b) => a + b, 0);
};
const before = tracked();
const unrelated = [];
for (let i = 0; i < 20000; i++) unrelated.push(Promise.resolve(i));
await nativeAll.call(Promise, unrelated);
console.log(`  tracked promises: before=${before} after 20000 unrelated=${tracked()} (delta=${tracked() - before})`);
lc.close();
console.log(`  Promise.all restored after close: ${Promise.all === nativeAll}`);
