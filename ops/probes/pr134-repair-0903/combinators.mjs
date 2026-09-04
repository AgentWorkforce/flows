// Does the in-flight rule cover every combinator, or only the registered one?
// Promise.allSettled / any / race are NOT intercepted, so their aggregate is not
// downstream of any member by `trigger`; it inherits attribution only from the
// context that resolves it.
import { flow, runFlow, verdict } from './harness.mjs';
const ticks = (n) => async () => { for (let i = 0; i < n; i++) await null; };

const exploit = (name, consume) => flow(name, async (f) => {
  const consumed = consume(f.run('true'));
  const derived = consumed.then(async () => {
    await ticks(10)();
    throw new Error(`derived post-processing failed (${name})`);
  });
  derived.catch(() => undefined);
  await consumed;
  f.done('success');
});
const legit = (name, consume) => flow(name, async (f) => { await consume(f.run('true')); f.done('success'); });
const ignored = (name, consume) => flow(name, async (f) => {
  void consume(f.run('true'));
  await new Promise((r) => setTimeout(r, 60));
  f.done('success');
});

const shapes = {
  'Promise.allSettled': (s) => Promise.allSettled([s]),
  'Promise.any       ': (s) => Promise.any([s]),
  'Promise.race      ': (s) => Promise.race([s]),
  'Promise.all       ': (s) => Promise.all([s]),
  'Promise.resolve   ': (s) => Promise.resolve(s),
};
for (const [label, consume] of Object.entries(shapes)) {
  const l = verdict(await runFlow(legit(`legit-${label.trim()}`, consume)));
  const x = verdict(await runFlow(exploit(`exploit-${label.trim()}`, consume)));
  const g = verdict(await runFlow(ignored(`ignored-${label.trim()}`, consume)));
  console.log(`${label}  awaited=${l.padEnd(22)} deferred-derived-failure=${x.padEnd(26)} ignored=${g}`);
}
