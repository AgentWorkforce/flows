import { describe, expect, it } from 'vitest';
import { parallelRunEligible } from '../src/authored-parallel-eligibility.js';

const body = (source: string): Function => new Function(`return (${source});`)() as Function;
const eligible = (candidate: Function, moduleSource = `import { flow } from '@relayflows/surface';\nexport default flow('probe', ${Function.prototype.toString.call(candidate)});`) =>
  parallelRunEligible(candidate, moduleSource);

describe('parallel run admission', () => {
  it('certifies direct Promise.all and awaited branch continuations', () => {
    expect(eligible(body(`async f => {
      const outputs = await Promise.all([f.run('a'), f.run('b')]);
      await f.run(outputs[0]);
      f.done('success');
    }`))).toBe(true);
    expect(eligible(body(`async f => {
      const left = async () => { await f.run('a'); await f.run('b'); };
      const right = async () => { await f.run('c'); await f.run('d'); };
      await Promise.all([left(), right()]);
      f.done('success');
    }`))).toBe(true);
    expect(eligible(body(`async f => {
      await Promise.all([f.run('a'), f.run('b'), f.run('c')]);
      f.done('success');
    }`))).toBe(true);
    expect(eligible(body(`async f => {
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
    for (const source of cases) expect(eligible(body(source)), source).toBe(false);
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
    for (const source of cases) expect(eligible(body(source)), source).toBe(false);
  });

  it('reads the function itself rather than an author-supplied toString', () => {
    const unsafe = body(`async f => { await Promise.race([f.run('a'), f.run('b')]); }`);
    unsafe.toString = () => `async f => { await Promise.all([f.run('a'), f.run('b')]); }`;
    expect(eligible(unsafe)).toBe(false);
  });

  it('keeps generated fanout serial even if Array.from is replaced', () => {
    const candidate = body(`async f => {
      await Promise.all(Array.from({ length: 2 }, (_, i) => f.run(String(i))));
    }`);
    const original = Array.from;
    try {
      Array.from = ((...args: Parameters<typeof Array.from>) => original(...args)) as typeof Array.from;
      expect(eligible(candidate)).toBe(false);
    } finally { Array.from = original; }
  });

  it('requires the module Promise binding to be the intrinsic', () => {
    const candidate = body(`async f => {
      await Promise.all([f.run('A'), f.run('B')]);
      await f.run('X');
      f.done('success');
    }`);
    const definition = `export default flow('probe', ${Function.prototype.toString.call(candidate)});`;
    expect(eligible(candidate, `import { flow } from '@relayflows/surface';\n${definition}`)).toBe(true);
    for (const prefix of [
      `const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };`,
      `import Promise from 'bluebird';`,
      `class Promise extends globalThis.Promise { static all(items) { return super.all(items); } }`,
      `function helper(Promise) { return Promise; }`,
      `const globalThis = { Promise: replacement };`,
      `globalThis.Promise = replacement;`,
      `globalThis['Promise'] = replacement;`,
      `Promise.all = replacement;`,
      `const intrinsic = globalThis; intrinsic.Promise = replacement;`,
      `global.Promise = replacement;`,
    ]) expect(eligible(candidate, `${prefix}\n${definition}`), prefix).toBe(false);
    expect(eligible(candidate,
      `export default (Promise.all = replacement, flow('probe', ${Function.prototype.toString.call(candidate)}));`))
      .toBe(false);
  });

  it('requires the entry module itself to define the body', () => {
    const candidate = body(`async f => {
      await Promise.all([f.run('A'), f.run('B')]);
      await f.run('X');
      f.done('success');
    }`);
    expect(eligible(candidate, `export { default } from './impl.ts';`)).toBe(false);
    expect(eligible(candidate, `import impl from './impl.ts'; export default impl;`)).toBe(false);
  });

  it('requires the exported arrow to be the actual body from the direct Surface binding', () => {
    const candidate = body(`async f => {
      await Promise.all([f.run('A'), f.run('B')]);
      await f.run('X');
      f.done('success');
    }`);
    const decoy = `export default flow('decoy', async f => { await f.run('decoy'); });`;
    const exact = `export default flow('real', ${Function.prototype.toString.call(candidate)});`;
    expect(eligible(candidate, `const flow = () => impl; ${decoy}`)).toBe(false);
    expect(eligible(candidate, `import { flow } from './wrap.ts'; ${decoy}`)).toBe(false);
    expect(eligible(candidate, `import { flow } from '@relayflows/surface'; ${decoy}`)).toBe(false);
    expect(eligible(candidate, exact)).toBe(false);
    expect(eligible(candidate, `const flow = () => impl; ${exact}`)).toBe(false);
    expect(eligible(candidate, `import { flow } from './wrap.ts'; ${exact}`)).toBe(false);
    expect(eligible(candidate, `import { flow } from '@relayflows/surface';\nimport './patch.mjs';\nexport default flow('real', ${Function.prototype.toString.call(candidate)});`)).toBe(false);
    expect(eligible(candidate, `import { flow } from '@relayflows/surface';\nconst alias = Function('return this')();\nexport default flow('real', ${Function.prototype.toString.call(candidate)});`)).toBe(false);
    expect(eligible(candidate, `import { flow } from '@relayflows/surface';\nexport default flow('real', { get extra() { throw new Error('side effect'); } }, ${Function.prototype.toString.call(candidate)});`)).toBe(false);
  });

  it('keeps groups with empty async branches serial', () => {
    expect(eligible(body(`async f => {
      const warm = async () => {};
      await Promise.all([warm(), warm()]);
      await f.run('X');
      f.done('success');
    }`))).toBe(false);
    expect(eligible(body(`async f => {
      const work = async () => { await f.run('A'); };
      const warm = async () => {};
      await Promise.all([work(), warm()]);
      f.done('success');
    }`))).toBe(false);
  });
});
