// P0: the derived-chain gate must not depend on WHEN a derived failure lands.
// Same program three times; only the delay before the throw differs.
import { flow, runFlow, report } from './harness.mjs';

const exploit = (name, defer) => flow(name, async (f) => {
  const step = f.run('true');
  const consumed = Promise.resolve(step);
  const derived = consumed.then(async () => {
    await defer();
    throw new Error(`derived post-processing failed (${name})`);
  });
  derived.catch(() => undefined);   // handled and forgotten
  await consumed;                   // root legitimately consumed
  f.done('success');
});
const ticks = (n) => async () => { for (let i = 0; i < n; i++) await null; };
const timer = (ms) => () => new Promise((r) => setTimeout(r, ms));

report('CONTROL  immediate throw (0 ticks)   [MUST refuse]', await runFlow(exploit('c0', ticks(0))));
report('EXPLOIT  10 microtask ticks          [MUST refuse]', await runFlow(exploit('x10', ticks(10))));
report('EXPLOIT  setTimeout(0)               [MUST refuse]', await runFlow(exploit('xt0', timer(0))));
