// Does aggregate attribution depend on WHICH member resolves the aggregate?
//
// `combinators.mjs` wraps a SINGLE step -- Promise.allSettled([s]) -- so the
// member determining settlement is always the step. A single-member aggregate
// cannot exhibit resolver-dependence by construction, so that probe is
// vacuous on this question. This probe uses TWO members and varies which one
// resolves the aggregate.
//
// RESULT (main @ 2026-09-07): attribution is resolver-INDEPENDENT. The
// hypothesised orphaning -- "an aggregate whose last settler is an ordinary
// promise loses step attribution" -- does NOT reproduce. See `sequenced`.
//
// The ordering knob matters more than the hypothesis did. Resolving the
// ordinary member from a continuation of the step (`s.then(...)`) refuses with
// `unawaited_step` REGARDLESS of the aggregate, and regardless of whether that
// continuation is itself awaited. Any probe that orders members that way
// measures the continuation, not the aggregate. `sequenced` orders them by
// awaiting the step directly, and is the only construction that isolates the
// question actually being asked.
import { flow, runFlow, verdict } from './harness.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const combinators = {
  'allSettled': (m) => Promise.allSettled(m),
  'any       ': (m) => Promise.any(m),
  'race      ': (m) => Promise.race(m),
  'all       ': (m) => Promise.all(m),
};

// stepResolves: the step settles first, so for all/allSettled the ordinary
// member is last and RESOLVES the aggregate; for race/any the step wins.
// otherResolves: the ordinary member settles before the step is awaited.
const sequenced = (combinator, otherFirst) => flow('x', async (f) => {
  const s = f.run('true');
  const other = deferred();
  const aggregate = combinator([s, other.promise]);
  if (otherFirst) {
    other.resolve('other');
    await aggregate;
    await s;                 // never leave the step unawaited
  } else {
    await s;
    other.resolve('other');
    await aggregate;
  }
  f.done('success');
});

const rows = [];
for (const [label, combinator] of Object.entries(combinators)) {
  const a = verdict(await runFlow(sequenced(combinator, true)));
  const b = verdict(await runFlow(sequenced(combinator, false)));
  const stable = a === b;
  if (!stable) rows.push(label.trim());
  console.log(`${label}  other-first=${a.padEnd(24)} step-first=${b.padEnd(24)} ${stable ? 'STABLE' : 'DIVERGENT'}`);
}

// Control: the ordering construction that a naive probe would reach for, shown
// to refuse for a reason unrelated to the aggregate.
const viaContinuation = (awaitLink) => flow('c', async (f) => {
  const s = f.run('true');
  const other = deferred();
  const aggregate = Promise.allSettled([s, other.promise]);
  const link = s.then(() => other.resolve('other'), () => other.resolve('other'));
  if (awaitLink) await Promise.all([aggregate, link]); else await aggregate;
  f.done('success');
});
console.log('\n--- control: ordering via a step continuation (not an aggregate question) ---');
console.log(`dangling link   ${verdict(await runFlow(viaContinuation(false)))}`);
console.log(`awaited  link   ${verdict(await runFlow(viaContinuation(true)))}`);

console.log(`\nresolver-dependent combinators: ${rows.length}${rows.length ? ' -> ' + rows.join(', ') : ''}`);
