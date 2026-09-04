// F1 + F2: an aggregate is derived from EVERY member, but the runtime supplies a
// resolutionCause edge to only ONE — whichever member resolved it. Every row here
// has AT LEAST TWO members and deliberately varies which one resolves the
// aggregate, because a single-member aggregate cannot exhibit the defect at all.
import { flow, runFlow, verdict } from './harness.mjs';

const ticks = (n) => async () => { for (let i = 0; i < n; i++) await null; };
const slower = (ms = 15) => new Promise((r) => setTimeout(() => r('unrelated'), ms));
const faster = () => Promise.resolve('unrelated-fast');

// --- F1: derived failure hidden behind an aggregate an unrelated member resolved
const escape = (name, build) => flow(name, async (f) => {
  const step = f.run('true');
  const agg = build(step);
  const derived = agg.then(async () => {
    await ticks(10)();
    throw new Error('work derived from the authored step failed');
  });
  derived.catch(() => undefined);            // handled and forgotten
  await agg;
  await step;
  f.done('success');
});

const escapes = {
  'allSettled([step, slowerUnrelated])  resolved by the UNRELATED member': (s) => Promise.allSettled([s, slower()]),
  'allSettled([slowerUnrelated, step])  resolved by the UNRELATED member': (s) => Promise.allSettled([slower(), s]),
  'race([fastUnrelated, step])          resolved by the UNRELATED member': (s) => Promise.race([faster(), s]),
  'any([fastUnrelated, step])           resolved by the UNRELATED member': (s) => Promise.any([faster(), s]),
  'all([step, slowerUnrelated])         resolved by the UNRELATED member': (s) => Promise.all([s, slower()]),
  'allSettled([step, fastUnrelated])    resolved by the STEP  (control)  ': (s) => Promise.allSettled([s, faster()]),
};
console.log('=== F1  deferred derived failure behind a multi-member aggregate  [ALL MUST REFUSE] ===');
for (const [label, build] of Object.entries(escapes)) {
  const r = await runFlow(escape(`esc-${label.slice(0, 12)}`, build));
  const ok = r.error !== undefined;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} | ${label} | ${verdict(r)}`);
}

// --- F2: correct, documented authoring that must NOT be refused
const legit = {
  'await Promise.allSettled([a, b])          ': async (f) => { await Promise.allSettled([f.run('true'), f.run('true')]); },
  'await Promise.allSettled over 5 steps     ': async (f) => { await Promise.allSettled([f.run('true'), f.run('true'), f.run('true'), f.run('true'), f.run('true')]); },
  'await Promise.all([a, b, c])              ': async (f) => { await Promise.all([f.run('true'), f.run('true'), f.run('true')]); },
  'await Promise.race([a, b])                ': async (f) => { await Promise.race([f.run('true'), f.run('true')]); },
  'await Promise.any([a, b])                 ': async (f) => { await Promise.any([f.run('true'), f.run('true')]); },
  'await step then reuse it in a later race  ': async (f) => { const s = f.run('true'); await s; await Promise.race([Promise.resolve('x'), s]); },
  'for await (const v of [a, b])             ': async (f) => { for await (const v of [f.run('true'), f.run('true')]) void v; },
  'for await (const v of [a])                ': async (f) => { for await (const v of [f.run('true')]) void v; },
  'allSettled mixing a step and an unrelated ': async (f) => { await Promise.allSettled([f.run('true'), slower(5)]); },
};
console.log('=== F2  correct, documented authoring  [ALL MUST PASS] ===');
for (const [label, body] of Object.entries(legit)) {
  const r = await runFlow(flow(`ok-${label.slice(0, 10)}`, async (f) => { await body(f); f.done('success'); }));
  const ok = r.error === undefined && r.terminal;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} | ${label} | ${verdict(r)}${r.error ? ' :: ' + r.error.message.slice(0, 90) : ''}`);
}
