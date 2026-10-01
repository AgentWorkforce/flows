import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

describe('shipped-source adversarial provenance regressions', () => {
  it('retains callable writes through member mutation, spreads, this, holes, and alternate receivers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-cubic-provenance-'));
    try {
      const cases = [
        `const state: any = { workers: [] }; state.workers.push(surface.flow); for (const define of state.workers) define('member-push', { budget: '$2' }, () => {});`,
        `const holder: any = {}; Object.assign(holder, ...[{ flows: [surface.flow] }]); for (const define of holder.flows) define('assign-spread', { budget: '$2' }, () => {});`,
        `const box: any = { install() { this.define = surface.flow; } }; box.install(); box.define('this-write', { budget: '$2' }, () => {});`,
        `const box: any = {}; ({ define: box.define = surface.flow } = {}); box.define('default-target', { budget: '$2' }, () => {});`,
        `const left: any = {}, right: any = {}; const box = flag ? left : right; Object.assign(box, { define: surface.flow }); left.define('alternate-target', { budget: '$2' }, () => {});`,
        `const box: any = {}; Reflect.apply(Reflect.set, Reflect, [box, , surface.flow]); box.undefined('hole-key', { budget: '$2' }, () => {});`,
        `const env = { reflect: Reflect }; const box: any = {}; env.reflect.set(box, 'define', surface.flow); box.define('nested-intrinsic', { budget: '$2' }, () => {});`,
        `const { Reflect: reflect } = globalThis; const box: any = {}; reflect.set(box, 'define', surface.flow); box.define('global-binding', { budget: '$2' }, () => {});`,
        `let invoke: any; invoke = surface.flow.call; invoke(surface, 'assigned-call-helper', { budget: '$2' }, () => {});`,
        `let invoke: any; invoke = surface.flow.apply; invoke(surface, ['assigned-apply-helper', { budget: '$2' }, () => {}]);`,
        `const operations = [surface.flow]; for (const key in operations) operations[key]('array-for-in', { budget: '$2' }, () => {});`,
        `function operations() { return { define: surface.flow }; } for (const key in operations()) operations()[key]('call-for-in', { budget: '$2' }, () => {});`,
        `const box: any = {}; let key: any = flag ? 'define' : 'other'; key ||= 'define'; box[key] = surface.flow; box.define('logical-assignment', { budget: '$2' }, () => {});`,
        `const [, ...[, ...[, ...defines]]] = [undefined, undefined, undefined, surface.flow]; defines[0]('triple-rest', { budget: '$2' }, () => {});`,
      ];
      for (const [index, candidate] of cases.entries()) {
        const file = join(directory, `case-${index}.flow.ts`);
        writeFileSync(file, `import * as surface from '@relayflows/surface'; declare const flag: boolean; ${candidate}`);
        expect(scanTypeScript(file).invalidFlowHeaders, candidate).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not manufacture intrinsic writes or comma-left callables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-cubic-negative-'));
    try {
      const cases = [
        `const Object = { assign() {} }; const box: any = {}; Object.assign(box, { define: surface.flow }); box.define('shadowed-object', { budget: '$2' }, () => {});`,
        `const noop = () => undefined; (surface.flow, noop)('comma-right', { budget: '$2' }, () => {});`,
        `const holder: any = { define: () => undefined }; holder.define('before-write', { budget: '$2' }, () => {}); holder.define = surface.flow;`,
        `function ignore(_value: unknown) {} ignore(surface.flow);`,
      ];
      for (const [index, candidate] of cases.entries()) {
        const file = join(directory, `negative-${index}.flow.ts`);
        writeFileSync(file, `import * as surface from '@relayflows/surface'; ${candidate}`);
        expect(scanTypeScript(file).invalidFlowHeaders, candidate).toEqual([]);
      }

      const unrelated = join(directory, 'unrelated-computed-binding.flow.ts');
      writeFileSync(unrelated, `
        declare const runtimeKey: string;
        const source = { callback: () => undefined };
        const { [runtimeKey]: callback } = source;
        callback();
      `);
      expect(scanTypeScript(unrelated).calls).toBe(0);

      const intrinsic = join(directory, 'computed-reflect-binding.flow.ts');
      writeFileSync(intrinsic, `
        declare const f: any;
        const key = 'apply' as const;
        const { [key]: apply } = Reflect;
        apply(f.agent, f, ['review', { task: 'x' }]);
      `);
      expect(scanTypeScript(intrinsic).calls).toBe(1);

      const opaque = join(directory, 'opaque-computed-binding.flow.ts');
      writeFileSync(opaque, `
        declare const f: any, unknown: any;
        const { o: obj = { k: 'agent' as const } } = unknown;
        const { [obj.k]: run } = f;
        run('review', { task: 'x' });
      `);
      const opaqueResult = scanTypeScript(opaque);
      expect(opaqueResult.calls).toBe(1);
      expect(opaqueResult.missing).toEqual([
        expect.stringContaining('statically unauditable arguments'),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('treats constructor and implicit-this receiver escapes as possible worker writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-cubic-receiver-'));
    try {
      const cases = [
        `class Mutator { constructor(receiver: any) { receiver.agent = () => undefined; } } new Mutator(f);`,
        `function mutate(this: any) { this.agent = () => undefined; } mutate.call(f);`,
      ];
      for (const [index, mutation] of cases.entries()) {
        const file = join(directory, `receiver-${index}.flow.ts`);
        writeFileSync(file, `
          declare const f: { agent(name: string, options: { cli: string; model: string }): void };
          ${mutation}
          f.agent('review', { cli: 'claude', model: 'claude-sonnet-5' });
        `);
        const result = scanTypeScript(file);
        expect(result.calls, mutation).toBe(1);
        expect(result.pairs, mutation).toEqual([]);
        expect(result.missing, mutation).toEqual([
          expect.stringContaining('statically unauditable arguments'),
        ]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not apply later alias assignments retroactively to copied values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-cubic-temporal-'));
    try {
      const cases = [
        `const box: any = {}, a: any = {}, b: any = {}; a.descriptors = b.descriptors; b.descriptors = a.descriptors; b.descriptors = { run: { value: f.agent } }; Object.defineProperties(box, a.descriptors); box.run('review', { task: 'x' });`,
        `const box: any = {}, a: any = {}, b: any = {}; a.getter = b.getter; b.getter = a.getter; b.getter = () => f.agent; Object.defineProperty(box, 'run', { get: a.getter }); box.run('review', { task: 'x' });`,
      ];
      for (const [index, candidate] of cases.entries()) {
        const file = join(directory, `temporal-${index}.flow.ts`);
        writeFileSync(file, `declare const f: any; ${candidate}`);
        expect(scanTypeScript(file).calls, candidate).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
