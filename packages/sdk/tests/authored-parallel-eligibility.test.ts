import { describe, expect, it } from 'vitest';
import { parallelRunEligible } from '../src/authored-parallel-eligibility.js';

const body = (source: string): Function => new Function(`return (${source});`)() as Function;

describe('parallel run admission', () => {
  it('certifies direct Promise.all and awaited branch continuations', () => {
    expect(parallelRunEligible(body(`async f => {
      const outputs = await Promise.all([f.run('a'), f.run('b')]);
      await f.run(outputs[0]);
      f.done('success');
    }`))).toBe(true);
    expect(parallelRunEligible(body(`async f => {
      const left = async () => { await f.run('a'); await f.run('b'); };
      const right = async () => { await f.run('c'); await f.run('d'); };
      await Promise.all([left(), right()]);
      f.done('success');
    }`))).toBe(true);
    expect(parallelRunEligible(body(`async f => {
      await Promise.all([f.run('a'), f.run('b'), f.run('c')]);
      f.done('success');
    }`))).toBe(true);
    expect(parallelRunEligible(body(`async f => {
      const route = async () => { await f.run('route'); await f.run('dependent'); };
      const second = async () => { await f.run('other'); await f.run('follow-up'); };
      await Promise.all([route(), second()]);
      await f.run('joined');
      f.done('success');
    }`))).toBe(true);
  });

  it('falls back for completion-order and hidden-effect shapes', () => {
    const cases = [
      // K1/K12: imported timers and for-await before a first child.
      `async f => { const pause = () => sleep(300);
        const late = async () => { await Promise.all([pause(), pause()]); await f.run('L'); };
        const fast = async () => { await f.run('A'); await f.run('B'); };
        await Promise.all([fast(), late()]); f.done('success'); }`,
      `async f => { const late = async () => { for await (const x of source) await f.run(x); };
        await Promise.all([late(), f.run('A')]); f.done('success'); }`,
      // K2b/K3: closure-shared readiness and completion-order mutation.
      `async f => { const late = async () => { await Promise.all([ready(), ready()]); await f.run('C'); };
        await Promise.all([f.run('A'), late()]); f.done('success'); }`,
      `async f => { const out = []; const left = async () => { out.push(await f.run('A')); };
        const right = async () => { out.push(await f.run('B')); };
        await Promise.all([left(), right()]); await f.run(out.join('')); f.done('success'); }`,
      // K4: an arguments alias can reach f.llm without spelling f.llm.
      `async function (f) { const g = arguments[0]; const ask = async () => { await g.llm('x'); };
        await Promise.all([ask(), f.run('A')]); f.done('success'); }`,
      // K5/K5b: non-step recursive joins can truncate the predecessor graph.
      `async f => { const descend = async n => n ? Promise.all([descend(n - 1), descend(n - 1)]) : 1;
        await Promise.all([descend(12), f.run('A')]); await f.run('B'); f.done('success'); }`,
      // K13b: completion from inside a branch changes peer admission order.
      `async f => { const a = async () => { await f.run('A'); f.done('success'); };
        const b = async () => { await f.run('B'); await f.run('C'); };
        await Promise.all([a(), b()]); }`,
    ];
    for (const source of cases) expect(parallelRunEligible(body(source)), source).toBe(false);
  });

  it('keeps race, any, eager work, timers, and mixed effects serial', () => {
    const cases = [
      `async f => { await Promise.race([f.run('a'), f.run('b')]); await f.run('c'); }`,
      `async f => { await Promise.any([f.run('a'), f.run('b')]); await f.run('c'); }`,
      `async f => { const background = async () => f.run('a'); background();
        await Promise.all([f.run('b'), f.run('c')]); }`,
      `async f => { const background = (async () => f.run('a'))();
        await Promise.all([f.run('b'), f.run('c')]); await background; }`,
      `async f => { const background = f.run('a');
        await Promise.all([f.run('b'), f.run('c')]); await background; }`,
      `async f => { const group = Promise.all([f.run('a'), f.run('b')]);
        await group; }`,
      `async f => { await Promise.all(Array.from({ length: Math.random() * 10 },
        (_, i) => f.run(String(i)))); }`,
      `async f => { await Promise.all(Array.from({ length: 9 }, (_, i) => f.run('' + i))); }`,
      `async f => { const others = [f.run('a')];
        await Promise.all([...others, f.run('b')]); }`,
      `async f => { await Promise.all([f.run('a'), f.run('b')]);
        await new Promise(resolve => setTimeout(resolve, 1)); }`,
      `async f => { await Promise.all([f.llm('a'), f.run('b')]); }`,
      `async f => { await Promise.all([f.dispatch('a'), f.run('b')]); }`,
      `async f => { const alias = f; await Promise.all([alias.run('a'), f.run('b')]); }`,
    ];
    for (const source of cases) expect(parallelRunEligible(body(source)), source).toBe(false);
  });

  it('reads the function itself rather than an author-supplied toString', () => {
    const unsafe = body(`async f => { await Promise.race([f.run('a'), f.run('b')]); }`);
    unsafe.toString = () => `async f => { await Promise.all([f.run('a'), f.run('b')]); }`;
    expect(parallelRunEligible(unsafe)).toBe(false);
  });

  it('keeps generated fanout serial even if Array.from is replaced', () => {
    const candidate = body(`async f => {
      await Promise.all(Array.from({ length: 2 }, (_, i) => f.run(String(i))));
    }`);
    const original = Array.from;
    try {
      Array.from = ((...args: Parameters<typeof Array.from>) => original(...args)) as typeof Array.from;
      expect(parallelRunEligible(candidate)).toBe(false);
    } finally { Array.from = original; }
  });
});
