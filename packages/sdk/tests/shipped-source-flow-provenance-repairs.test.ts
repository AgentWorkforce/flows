import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

describe('shipped-source flow provenance repairs', () => {
  it('audits repaired writer, alias, binding, and cyclic provenance forms', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-flow-provenance-repairs-'));
    try {
      const cases = [
        `{ const box: any = {}, helpers: any = {}; helpers.assign = Object.assign; helpers.assign(box, { define: surface.flow }); box.define('member-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, maps: any = {}; maps.descriptors = { define: { value: surface.flow } }; Object.defineProperties(box, maps.descriptors); box.define('member-map', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function identity(value: any) { const alias = value; return alias; } Object.assign(identity(box), { define: surface.flow }); box.define('const-alias', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function identity(value: any) { let alias; alias = value; return alias; } Object.assign(identity(box), { define: surface.flow }); box.define('assigned-alias', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function identity(value: any) { return flag ? value : value; } Object.assign(identity(box), { define: surface.flow }); box.define('wrapped-return', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function getBox() { return box; } Object.assign(getBox(), { define: surface.flow }); box.define('captured-return', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, getter = () => surface.flow; Object.defineProperty(box, 'define', { get: getter }); box.define('getter-alias', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function id(...values: any[]) { return values[0]; } Object.assign(id(box), { define: surface.flow }); box.define('rest-formal', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function id({ value }: { value: any }) { return value; } Object.assign(id({ value: box }), { define: surface.flow }); box.define('destructured-formal', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function id(value: any) { return value; } Object.assign(id(...[box]), { define: surface.flow }); box.define('spread-actual', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function id(value: any = box) { return value; } Object.assign(id(), { define: surface.flow }); box.define('default-formal', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, alias = box; alias.define = surface.flow; box.define('receiver-alias', { budget: '$2' }, () => {}); }`,
        `{ let key: string; key = 'flow'; const { [key]: define } = surface; define('mutable-key', { budget: '$2' }, () => {}); }`,
        `{ const source = flag ? { key: 'flow' as const } : { key: 'flow' as const }; const { key } = source; const { [key]: define } = surface; define('wrapped-key-source', { budget: '$2' }, () => {}); }`,
        `{ const source = (flag && { key: 'flow' as const }) || { key: 'flow' as const }; const { key } = source; const { [key]: define } = surface; define('logical-key-source', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, a: any = {}, b: any = {}; a.descriptors = b.descriptors; b.descriptors = a.descriptors; b.descriptors = { define: { value: surface.flow } }; Object.defineProperties(box, a.descriptors); box.define('cyclic-descriptor-map', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, a: any = {}, b: any = {}; a.getter = b.getter; b.getter = a.getter; b.getter = () => surface.flow; Object.defineProperty(box, 'define', { get: a.getter }); box.define('cyclic-getter-alias', { budget: '$2' }, () => {}); }`,
      ];
      for (const [index, candidate] of cases.entries()) {
        const file = join(directory, `repaired-flow-${index}.flow.ts`);
        writeFileSync(file, `import * as surface from '@relayflows/surface'; declare const flag: boolean; ${candidate}`);
        expect(scanTypeScript(file).invalidFlowHeaders, candidate).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
