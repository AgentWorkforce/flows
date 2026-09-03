// P1-A: pre-constructed steps awaited later are ordinary authoring and must pass.
// The refusals below must stay refusals.
import { flow, runFlow, report } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

report('E1 create a,b; await a; await b            [MUST pass]', await runFlow(flow('e1', async (f) => {
  const a = f.run('true'), b = f.run('true'); await a; await b; f.done('success');
})));
report('E2 create a,b; await b; await a            [MUST pass]', await runFlow(flow('e2', async (f) => {
  const a = f.run('true'), b = f.run('true'); await b; await a; f.done('success');
})));
report('E5 array of steps awaited in a loop        [MUST pass]', await runFlow(flow('e5', async (f) => {
  const steps = [f.run('true'), f.run('true'), f.run('true')];
  for (const s of steps) await s; f.done('success');
})));
report('E4 await Promise.all([a,b])                [MUST pass]', await runFlow(flow('e4', async (f) => {
  await Promise.all([f.run('true'), f.run('true')]); f.done('success');
})));
report('S4 ignored Promise.resolve(step)           [MUST refuse]', await runFlow(flow('s4', async (f) => {
  void Promise.resolve(f.run('true')); await sleep(100); f.done('success');
})));
report('S4b ignored Promise.all([a,b])             [MUST refuse]', await runFlow(flow('s4b', async (f) => {
  void Promise.all([f.run('true'), f.run('true')]); await sleep(100); f.done('success');
})));
report('C5 withResolvers forgery                   [MUST refuse]', await runFlow(flow('c5', async (f) => {
  const d = Promise.withResolvers();
  f.run('true').then(d.resolve, d.reject); await sleep(100); f.done('success');
})));
report('C8 forged toString + manual .then          [MUST refuse]', await runFlow(flow('c8', async (f) => {
  const o = Function.prototype.toString;
  Function.prototype.toString = () => 'function () { [native code] }';
  try { f.run('true').then(() => undefined, () => undefined); await sleep(100); }
  finally { Function.prototype.toString = o; }
  f.done('success');
})));
report('D4 done() from a setTimeout after body ret [MUST refuse]', await runFlow(flow('d4', async (f) => {
  const s = f.run('true');
  setTimeout(() => { try { f.done('success'); } catch {} }, 10);
  void s;
})));
report('IIFE detached await                        [MUST refuse]', await runFlow(flow('iife', async (f) => {
  const s = f.run('true');
  void (async () => { await s; })(); await sleep(50); f.done('success');
})));
