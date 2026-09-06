// P1-B: cost of the completion gate against ordinary in-flow promise churn.
// Usage: node gate-cost.mjs [distDir] [awaits]   (distDir defaults to "dist")
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = process.argv[2] ?? 'dist';
const N = Number(process.argv[3] ?? 30000);
const { AuthoredFlowOperation, verifyAuthoredOperations } = await import(`${REPO}/packages/sdk/${DIST}/authored-flow-operation.js`);
const { AuthoredFlowLifecycle } = await import(`${REPO}/packages/sdk/${DIST}/authored-flow-lifecycle.js`);

const lc = new AuthoredFlowLifecycle();
const ops = [];
const mk = () => {
  const o = new AuthoredFlowOperation(`run-${ops.length + 1}`, 'run', () => undefined, async () => 'v', lc);
  ops.push(o); return o;
};
let t0 = Date.now();
await lc.runBody(async () => {
  await mk().step;
  for (let i = 0; i < N; i++) await Promise.resolve(i);   // ordinary in-flow async work
  lc.markCompletion();
});
const bodyMs = Date.now() - t0;
t0 = Date.now();
let err = null;
try { await verifyAuthoredOperations('gate-cost', ops, lc); } catch (e) { err = e; }
console.log(`${DIST} awaits=${N}  body=${bodyMs}ms  verifyAuthoredOperations=${Date.now() - t0}ms  verdict=${err ? err.code : 'PASSED'}`);
lc.close();
