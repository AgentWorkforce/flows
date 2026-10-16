import { describe, expect, it } from 'vitest';
import { instrumentParallelBody } from '../src/authored-parallel-body.js';

describe('certified authored parallel body', () => {
  it('records the exact branch-call promises before the join is awaited', async () => {
    const body = new Function(`return (async f => {
      const left = async () => { await f.run('A'); await f.run('A2'); };
      const right = async () => { await f.run('B'); await f.run('B2'); };
      await Promise.all([left(), right()]);
      f.done('success');
    });`)() as (ctx: { run: (command: string) => Promise<string>; done: (reason: string) => void }) => Promise<void>;
    const certified: Promise<unknown>[] = [];
    const commands: string[] = [];
    const executable = instrumentParallelBody(body, promise => certified.push(promise));
    const result = executable({
      run: async command => { commands.push(command); return command; },
      done: () => {},
    });
    expect(certified).toHaveLength(2);
    expect(new Set(certified).size).toBe(2);
    await result;
    expect(commands).toEqual(['A', 'B', 'A2', 'B2']);
  });

  it('refuses an unsupported join before executing the body', () => {
    const unsafe = new Function(`return (async f => {
      await Promise.race([f.run('A'), f.run('B')]);
      await f.run('X');
      f.done('success');
    });`)() as Function;
    expect(() => instrumentParallelBody(unsafe, () => {})).toThrow(/lost its source certificate/u);
  });

  it('checks unsafe joins independently of the entry eligibility decision', () => {
    const bodies = [
      `await Promise.race([f.run('A'), f.run('B')]);`,
      `await Promise.any([f.run('A'), f.run('B')]);`,
      `await Promise.all([Promise.race([f.run('A'), f.run('B')]), f.run('C')]);`,
      `const first = new Promise(resolve => resolve());
       await Promise.all([first, f.run('A')]);`,
      `const a = f.run('A'); const thenable = { then: resolve => a.then(resolve) };
       await Promise.all([thenable, f.run('B')]);`,
      `await Promise.all(new Set([f.run('A'), f.run('B')]));`,
      `await Promise.all([f.run('A'), f.run('B')]).then(value => value);`,
      `const Promise = { all: values => globalThis.Promise.all(values) };
       await Promise.all([f.run('A'), f.run('B')]);`,
    ];
    for (const source of bodies) {
      const body = new Function(`return (async f => { ${source} f.done('success'); });`)() as Function;
      expect(() => instrumentParallelBody(body, () => {}), source).toThrow(/lost its source certificate/u);
    }
  });
});
