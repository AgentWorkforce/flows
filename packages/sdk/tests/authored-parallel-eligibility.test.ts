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
      await Promise.all(Array.from({ length: 9 }, (_, i) => f.run(String(i))));
      f.done('success');
    }`))).toBe(true);
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

  it('keeps a replaced Array.from scheduler in serial mode', () => {
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
