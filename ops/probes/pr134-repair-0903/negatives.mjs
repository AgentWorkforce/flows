// Over-attribution guard: ordinary work that merely FOLLOWS an authored step
// must not be mistaken for work derived from it.
import { flow, runFlow, verdict } from './harness.mjs';
const cases = {
  'step then 500 unrelated awaits then done   [MUST PASS]': flow('n1', async (f) => {
    await f.run('true');
    for (let i = 0; i < 500; i++) await Promise.resolve(i);
    f.done('success');
  }),
  'step then unrelated timer awaited          [MUST PASS]': flow('n2', async (f) => {
    await f.run('true'); await new Promise((r) => setTimeout(r, 20)); f.done('success');
  }),
  'step then unrelated chain awaited          [MUST PASS]': flow('n3', async (f) => {
    await f.run('true');
    await Promise.resolve(1).then((x) => x + 1).then(async (x) => { await null; return x; });
    f.done('success');
  }),
  'two steps, unrelated work between          [MUST PASS]': flow('n4', async (f) => {
    await f.run('true'); await new Promise((r) => setTimeout(r, 5)); await f.run('true'); f.done('success');
  }),
  'awaited allSettled, derived chain awaited  [MUST PASS]': flow('n5', async (f) => {
    const c = Promise.allSettled([f.run('true')]);
    await c.then((rs) => rs.length);
    f.done('success');
  }),
  'nested Promise.all over Promise.resolve    [MUST PASS]': flow('n6', async (f) => {
    await Promise.all([Promise.resolve(f.run('true')), Promise.resolve(f.run('true'))]);
    f.done('success');
  }),
  'step then UNRELATED fire-and-forget        [observe]': flow('n7', async (f) => {
    await f.run('true');
    void (async () => { await new Promise((r) => setTimeout(r, 40)); })();
    f.done('success');
  }),
};
for (const [label, handle] of Object.entries(cases)) {
  console.log(`${label}  ->  ${verdict(await runFlow(handle))}`);
}
