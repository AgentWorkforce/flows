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
        `{ const box: any = {}, captured = { keys: { value: 'define' as const } }; function get() { return captured; } box[get().keys.value] = surface.flow; box.define('captured-caller-path', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function key(value: any) { return value; } let alias: any; box[(alias = key({ name: 'define' })).name] = surface.flow; box.define('assignment-wrapped-caller-path', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function key(value: any) { return value; } let alias: any; box[(alias ||= key({ name: 'define' })).name] = surface.flow; box.define('logical-assignment-wrapped-caller-path', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; const source = flag ? { key: 'other' as const } : { key: 'define' as const }; const { key } = source; box[key] = surface.flow; box.define('branched-destructured-key', { budget: '$2' }, () => {}); }`,
        `{ const source = flag ? { define: () => undefined } : { define: surface.flow }; const { define } = source; define('alternate-destructured-callable', { budget: '$2' }, () => {}); }`,
        `{ const source = flag ? { nested: { define: () => undefined } } : { nested: { define: surface.flow } }; const { nested: { define } } = source; define('nested-alternate-destructured-callable', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function id(value: any) { return value; } box[id(id({ name: 'define' })).name] = surface.flow; box.define('nested-same-helper-caller-path', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; const source = flag ? { key: 'other' as const } : { key: runtimeKey }; declare const runtimeKey: string; const { key } = source; box[key] = surface.flow; box.define('unresolved-aggregate-key', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; const captured = flag ? { keys: { value: 'other' as const } } : { keys: { value: 'define' as const } }; function get() { return captured.keys; } box[get().value] = surface.flow; box.define('captured-parent-alternatives', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; let key = 'other'; if (flag) key = 'define'; box[key] = surface.flow; box.define('mutable-initializer-key', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; let { key } = { key: 'other' }; if (flag) key = 'define'; box[key] = surface.flow; box.define('mutable-destructured-initializer-key', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; let { key } = { key: runtimeKey }; key = 'define'; box[key] = surface.flow; box.define('unresolved-destructured-initializer-key', { budget: '$2' }, () => {}); }`,
        `{ const { [runtimeKey]: define = surface.flow } = surface; define('unresolved-computed-default', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; let key = 'other'; for (const item of items) { box[key] = surface.flow; key = 'define'; } box.define('loop-carried-key', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; let key = 'other'; function install() { box[key] = surface.flow; key = 'define'; } install(); install(); box.define('repeated-function-key', { budget: '$2' }, () => {}); }`,
        `{ const source = flag ? { outer: { define: () => undefined } } : { outer: { define: surface.flow } }; const { outer } = source; const { define } = outer; define('chained-destructured-callable', { budget: '$2' }, () => {}); }`,
        `{ const [outer] = flag ? [{ define: () => undefined }] : [{ define: surface.flow }]; const { define } = outer; define('array-alternative-callable', { budget: '$2' }, () => {}); }`,
        `{ let { outer } = flag ? { outer: { define: () => undefined } } : { outer: { define: surface.flow } }; const { define } = outer; define('mutable-chained-callable', { budget: '$2' }, () => {}); }`,
        `{ let define: any; ({ define } = flag ? { define: () => undefined } : { define: surface.flow }); define('assigned-alternative-callable', { budget: '$2' }, () => {}); }`,
        `{ let define: any; for (define of [surface.flow]) define('for-of-callable', { budget: '$2' }, () => {}); }`,
        `{ const values = [surface.flow]; let define: any; for (define of values) define('for-of-alias-callable', { budget: '$2' }, () => {}); }`,
        `{ const holder = { values: [surface.flow] }; for (const define of holder.values) define('for-of-member-iterable-callable', { budget: '$2' }, () => {}); }`,
        `{ const { values } = { values: [surface.flow] }; for (const define of values) define('for-of-object-binding-alias', { budget: '$2' }, () => {}); }`,
        `{ const [values] = [[surface.flow]]; for (const define of values) define('for-of-array-binding-alias', { budget: '$2' }, () => {}); }`,
        `{ let values: any; ({ values } = { values: [surface.flow] }); for (const define of values) define('for-of-assigned-binding-alias', { budget: '$2' }, () => {}); }`,
        `{ let values: any; values ||= [surface.flow]; for (const define of values) define('for-of-logical-alias', { budget: '$2' }, () => {}); }`,
        `{ let define: any; for (define of [...[surface.flow]]) define('for-of-spread-callable', { budget: '$2' }, () => {}); }`,
        `{ let define: any; for (define of flag ? [() => undefined] : [surface.flow]) define('for-of-conditional-callable', { budget: '$2' }, () => {}); }`,
        `{ for (const define of [surface.flow]) define('for-of-declared-callable', { budget: '$2' }, () => {}); }`,
        `{ for (const [define] of [[surface.flow]]) define('for-of-destructured-callable', { budget: '$2' }, () => {}); }`,
        `{ for (const [, ...[, ...defines]] of [[0, () => undefined, surface.flow]]) defines[0]('for-of-nested-rest-callable', { budget: '$2' }, () => {}); }`,
        `{ for (const defines of [[surface.flow]]) for (const define of defines) define('nested-for-of-callable', { budget: '$2' }, () => {}); }`,
        `{ for (const [, ...defines] of [[0, surface.flow]]) for (const define of defines) define('nested-rest-for-of-callable', { budget: '$2' }, () => {}); }`,
        `{ const defines: any[] = []; defines.push(surface.flow); for (const define of defines) define('pushed-for-of-callable', { budget: '$2' }, () => {}); }`,
        `{ const box: any = { define: surface.flow }; let key: string; for (key in box) box[key]('for-in-object-callable', { budget: '$2' }, () => {}); }`,
        `{ const box: any = { define: surface.flow }; for (const key in box) box[key]('for-in-declared-object-callable', { budget: '$2' }, () => {}); }`,
        `{ const { box } = { box: { define: surface.flow } }; for (const key in box) box[key]('for-in-binding-alias', { budget: '$2' }, () => {}); }`,
        `{ const holder = { box: { define: surface.flow } }; for (const key in holder.box) holder.box[key]('for-in-member-iterable', { budget: '$2' }, () => {}); }`,
        `{ let box: any; ({ box } = { box: { define: surface.flow } }); for (const key in box) box[key]('for-in-assigned-alias', { budget: '$2' }, () => {}); }`,
        `{ let box: any; box ||= { define: surface.flow }; for (const key in box) box[key]('for-in-logical-alias', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; const source = flag ? { assign: () => undefined } : { assign: Object.assign }; const { assign } = source; assign(box, { define: surface.flow }); box.define('alternate-destructured-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; const source = flag ? { apply: () => undefined } : { apply: Reflect.apply }; const { apply } = source; apply(Object.assign, Object, [box, { define: surface.flow }]); box.define('alternate-destructured-reflect-apply', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; let assign: any; ({ assign } = flag ? { assign: () => undefined } : { assign: Object.assign }); assign(box, { define: surface.flow }); box.define('assigned-alternative-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; let assign: any; for (assign of [Object.assign]) assign(box, { define: surface.flow }); box.define('for-of-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, assigners = [Object.assign]; let assign: any; for (assign of assigners) assign(box, { define: surface.flow }); box.define('for-of-alias-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, assigners = [Object.assign]; for (const assign of assigners) assign(box, { define: surface.flow }); box.define('for-of-declared-alias-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, holder = { assigners: [Object.assign] }; for (const assign of holder.assigners) assign(box, { define: surface.flow }); box.define('for-of-member-iterable-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; for (const assigners of [[Object.assign]]) for (const assign of assigners) assign(box, { define: surface.flow }); box.define('nested-for-of-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, assigners: any[] = []; assigners.push(Object.assign); for (const assign of assigners) assign(box, { define: surface.flow }); box.define('pushed-for-of-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, { assigners } = { assigners: [Object.assign] }; for (const assign of assigners) assign(box, { define: surface.flow }); box.define('for-of-destructured-alias-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; for ({ define: box.run } of [{ define: surface.flow }]) {} box.run('for-of-member-target', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, state: any = {}; for (state.key in { define: true }) {} box[state.key] = surface.flow; box.define('for-in-member-target', { budget: '$2' }, () => {}); }`,
        `{ let { values } = { values: [surface.flow] }; values[0]('mutable-object-array-binding', { budget: '$2' }, () => {}); }`,
        `{ let [values] = [[surface.flow]]; values[0]('mutable-array-array-binding', { budget: '$2' }, () => {}); }`,
        `{ const [, ...[, ...values]] = [undefined, undefined, surface.flow]; values[0]('nested-immutable-rest', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, a: any = {}, b: any = {}; a.descriptors = b.descriptors; b.descriptors = a.descriptors; b.descriptors = { define: { value: surface.flow } }; Object.defineProperties(box, a.descriptors); box.define('cyclic-descriptor-map', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, a: any = {}, b: any = {}; a.getter = b.getter; b.getter = a.getter; b.getter = () => surface.flow; Object.defineProperty(box, 'define', { get: a.getter }); box.define('cyclic-getter-alias', { budget: '$2' }, () => {}); }`,
        `{ const key = 'flows' as const, holder = { flows: [surface.flow] }; for (const define of holder[key]) define('computed-member-iterable', { budget: '$2' }, () => {}); }`,
        `{ const holder: any = {}; Object.assign(holder, { flows: [surface.flow] }); for (const define of holder.flows) define('reflective-member-iterable', { budget: '$2' }, () => {}); }`,
        `{ function getHolder() { return { flows: [surface.flow] }; } for (const define of getHolder().flows) define('returned-member-iterable', { budget: '$2' }, () => {}); }`,
        `{ const flows: any[] = []; flows[0] = surface.flow; for (const define of flows) define('numeric-index-mutation', { budget: '$2' }, () => {}); }`,
        `{ const flows: any[] = [], alias = flows; alias.push(surface.flow); for (const define of flows) define('aliased-mutation', { budget: '$2' }, () => {}); }`,
        `{ let rest: any[]; [, ...rest] = flag ? [0, () => undefined] : [0, surface.flow]; rest[0]('rest-alternative', { budget: '$2' }, () => {}); }`,
        `{ const { o: obj = { k: 'flow' as const } } = unknown; const { [obj.k]: define } = surface; define('unresolved-nested-default', { budget: '$2' }, () => {}); }`,
        `{ const holder: any = flag ? { flows: holder.flows } : { flows: [surface.flow] }; for (const define of holder.flows) define('cyclic-member-iterable', { budget: '$2' }, () => {}); }`,
        `{ const holder = { flows: [surface.flow], other: [() => undefined] }; for (const define of holder[runtimeKey]) define('dynamic-member-iterable', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, holder: any = {}; Object.assign(holder, { ops: [Object.assign] }); for (const op of holder.ops) op(box, { define: surface.flow }); box.define('reflective-member-writer', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function getHolder() { return { ops: [Object.assign] }; } for (const op of getHolder().ops) op(box, { define: surface.flow }); box.define('returned-member-writer', { budget: '$2' }, () => {}); }`,
        `{ const holder: any = {}, alias = holder; Object.assign(alias, { flows: [surface.flow] }); for (const define of holder.flows) define('aliased-reflective-member', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}, holder: any = {}, alias = holder; Object.assign(alias, { ops: [Object.assign] }); for (const op of holder.ops) op(box, { define: surface.flow }); box.define('aliased-reflective-member-writer', { budget: '$2' }, () => {}); }`,
        `{ function inner() { return [surface.flow]; } function getHolder() { return { flows: inner() }; } for (const define of getHolder().flows) define('returned-call-array', { budget: '$2' }, () => {}); }`,
        `{ const box: any = {}; function inner() { return [Object.assign]; } function getHolder() { return { ops: inner() }; } for (const op of getHolder().ops) op(box, { define: surface.flow }); box.define('returned-call-array-writer', { budget: '$2' }, () => {}); }`,
        `{ function defineFlow({ o = { k: 'flow' as const } }: any) { const { [o.k]: define } = surface; define('parameter-default-key', { budget: '$2' }, () => {}); } defineFlow({ o: { k: 'task' } }); }`,
        `{ const [, defines] = [, [surface.flow]]; for (const define of defines) define('positional-hole', { budget: '$2' }, () => {}); }`,
        `{ const [defines] = flag ? [[() => undefined]] : [[surface.flow]]; for (const define of defines) define('positional-alternative', { budget: '$2' }, () => {}); }`,
      ];
      for (const [index, candidate] of cases.entries()) {
        const file = join(directory, `repaired-flow-${index}.flow.ts`);
        writeFileSync(file, `import * as surface from '@relayflows/surface'; declare const flag: boolean, items: unknown[], runtimeKey: string, unknown: any; ${candidate}`);
        expect(scanTypeScript(file).invalidFlowHeaders, candidate).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
