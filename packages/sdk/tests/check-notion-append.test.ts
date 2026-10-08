import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { check, directories, fixture, shippedExample, useHelperSurfaceEnv } from './helper-surface-fixture.js';

useHelperSurfaceEnv();

it.each([
  ['airtable', "await f.airtable.createRecord('base', 'table', {});"],
  ['notion appendBlock', "await f.notion.appendBlock('page', {});"],
])('still refuses unsupported %s without a mount', async (_name, body) => {
  const result = await check(fixture(body));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('does not refuse an unrelated .appendBlock in a Notion flow with no local mount', async () => {
  const body = `const doc = { appendBlock() { return 1; } };
    doc.appendBlock(); // f.notion.appendBlock is not called here
    const note = 'x.appendBlock';
    await f.notion.createPage({ parent: 'p', title: note });`;
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
  expect(result.stderr.join('\n')).toContain('[helper_credential_unresolved]');
});
it('still refuses a real f.notion.appendBlock through an aliased context name', async () => {
  const path = fixture('', '{ tools: { notion: true } },');
  writeFileSync(path, `import { flow } from '@relayflows/surface';
export default flow('test', { tools: { notion: true } }, async ctx => { await ctx.notion.appendBlock('page', {}); ctx.done('success'); });`);
  const result = await check(path);
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['an alias', 'const notion = f.notion; await notion.appendBlock("page", {});'],
  ['a destructured helper', 'const { notion } = f; await notion.appendBlock("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('keeps refusing a destructured f.notion.appendBlock method', async () => {
  const result = await check(fixture('const { appendBlock } = f.notion; await appendBlock("page", {});', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('does not treat an existence check of f.notion as a handoff', async () => {
  const body = `if (f.notion && typeof f.notion === 'object') await f.notion.createPage({ parent: 'p', title: 't' });
    const doc = { appendBlock() { return 1; } }; doc.appendBlock();`;
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it.each([
  ['nested destructuring', 'const { notion: { appendBlock } } = f; await appendBlock("page", {});'],
  ['an arrow expression body', 'const get = () => f.notion; await get().appendBlock("page", {});'],
  ['a parameter default', 'const run = async (n = f.notion) => n.appendBlock("page", {}); await run();'],
  ['a nested destructuring default', 'const { appendBlock: add = f.notion.appendBlock } = {}; await add("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('explains an alias-inferred appendBlock refusal and how to avoid it', async () => {
  const aliased = await check(fixture('const notion = f.notion; await notion.createPage({ parent: "p", title: "t" }); const doc = { appendBlock() {} }; doc.appendBlock();', '{ tools: { notion: true } },'));
  expect(aliased.exit).toBe(2);
  expect(aliased.stderr.join('\n')).toContain('f.notion is aliased, passed on or called through a computed name');
  const direct = await check(fixture('await f.notion.createPage({ parent: "p", title: "t" }); const doc = { appendBlock() {} }; doc.appendBlock();', '{ tools: { notion: true } },'));
  expect(direct.exit).toBe(0);
  const real = await check(fixture('await f.notion.appendBlock("page", {});', '{ tools: { notion: true } },'));
  expect(real.stderr.join('\n')).not.toContain('aliased, passed on');
});
it.each([
  ['a computed method', 'const method = "appendBlock"; await f.notion[method]("page", {});'],
  ['a computed namespace', 'const ns = "notion"; await f[ns].appendBlock("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('keeps refusing a computed call through an aliased f.notion', async () => {
  const result = await check(fixture('const notion = f.notion; const method = "appendBlock"; await notion[method]("page", {});', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a computed destructuring key', 'const method = "appendBlock"; const { [method]: append } = f.notion; await append("page", {});'],
  ['a rest element', 'const { createPage, ...rest } = f.notion; await rest.appendBlock("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['Reflect.get', 'await Reflect.get(f.notion, "appendBlock")("page", {});'],
  ['a string-keyed alias', 'const n = f.notion; await n["appendBlock"]("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a dynamic Reflect.get key', 'const method = String(Date.now()); await Reflect.get(f.notion, method)("page", {});'],
  ['a helper function', 'const call = (n, m) => n[m]; await call(f.notion, "append" + "Block")("page", {});'],
])('keeps refusing when f.notion is handed to %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['an optional chain', 'const method = String(Date.now()); await Reflect.get(f?.notion, method)("page", {});'],
  ['a logical fallback', 'const method = String(Date.now()); await Reflect.get(f.notion ?? {}, method)("page", {});'],
  ['a spread argument', 'const method = String(Date.now()); await Reflect.get(...[f.notion, method])("page", {});'],
])('keeps refusing when f.notion reaches a call through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['an object passed to a call', 'await globalThis.invokeHelper({ notion: f.notion }, "page");'],
  ['a returned helper', 'const get = () => { return f.notion; }; await globalThis.invokeHelper(get, "page");'],
  ['a property assignment', 'const box = {}; box.n = f.notion; await globalThis.invokeHelper(box, "page");'],
])('keeps refusing when f.notion escapes through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('an aliased f.notion refuses with the remedy, since its calls cannot be attributed', async () => {
  const result = await check(fixture('const notion = f.notion; await notion.createPage({ parent: "p", title: "t" });', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('call f.notion methods directly by name');
});
it.each([
  ['an alias handed to a call', 'const notion = f.notion; await globalThis.invokeHelper(notion, "page");'],
  ['a rebound alias handed on', 'const a = f.notion; const b = a; await globalThis.invokeHelper({ b }, "page");'],
  ['a destructured namespace handed on', 'const { notion } = f; await globalThis.invokeHelper(notion, "page");'],
])('keeps refusing when %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a short-circuit guard', 'f.notion && await f.notion.createPage({ parent: "p", title: "t" });'],
  ['a direct guard and comparison', 'if (f.notion !== undefined && typeof f.notion === "object") await f.notion.createPage({ parent: "p", title: "t" });'],
])('does not over-refuse %s that only calls supported methods', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it.each([
  ['a captured alias inside a root-shadowing function', 'const notion = f.notion; function call(f) { return notion.appendBlock("p", {}); } await call(1);'],
  ['an alias used as a default', 'const run = async (n = f.notion) => globalThis.invokeHelper(n); await run();'],
  ['an assignment used as an argument', 'let n; await globalThis.invokeHelper(n = f.notion);'],
])('refuses %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['valueOf()', 'await f.notion.valueOf().appendBlock("page", {});'],
  ['constructor', 'await globalThis.invokeHelper(f.notion.constructor);'],
])('refuses f.notion reached back through the inherited %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('an earlier comma operand is a discarded read, not a hand-off', async () => {
  const result = await check(fixture('const x = (f.notion, 1); await f.notion.createPage({ parent: "p", title: String(x) });', '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it.each([
  ['hasOwnProperty', 'if (f.notion.hasOwnProperty("createPage")) await f.notion.createPage({ parent: "p", title: "t" });'],
  ['toString after replacing it', 'let held; Object.prototype.toString = function () { held = this; return ""; }; f.notion.toString(); await held.appendBlock("p", {});'],
])('refuses the inherited call %s, since a replaced prototype can capture the helper', async (_name, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('still refuses an inherited member that is referenced rather than called', async () => {
  const result = await check(fixture('await globalThis.invokeHelper(f.notion.hasOwnProperty);', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it.each([
  ['direct eval', 'await eval("f.notion.appendBlock(\'page\', {})");'],
  ['the Function constructor', 'await new Function("f", "return f.notion.appendBlock(\'page\', {})")(f);'],
])('refuses code run through %s, which the scan cannot see', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('treats template interpolation as a read', async () => {
  const result = await check(fixture('const label = `${f.notion}`; await f.notion.createPage({ parent: "p", title: label });', '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it('still refuses a tagged template, which hands the value to its tag', async () => {
  const result = await check(fixture('await globalThis.tagHelper`${f.notion}`;', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it('refuses the context reached through arguments in a non-arrow body', async () => {
  const path = fixture('', '{ tools: { notion: true } },');
  writeFileSync(path, `import { flow } from '@relayflows/surface';
export default flow('test', { tools: { notion: true } }, async function (f) { await arguments[0].notion.appendBlock('p', {}); f.done('success'); });`);
  const result = await check(path);
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('a typeof probe of appendBlock is not a call', async () => {
  const result = await check(fixture('if (typeof f.notion.appendBlock === "function") await f.notion.createPage({ parent: "p", title: "t" });', '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it('an extracted appendBlock reference is unprovable', async () => {
  const result = await check(fixture('const add = f.notion.appendBlock; await add("p", {});', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it('an instanceof operand hands the helper to Symbol.hasInstance', async () => {
  const result = await check(fixture('if (f.notion instanceof globalThis.Probe) await f.notion.createPage({ parent: "p", title: "t" });', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it.each([
  ['a nested function', 'function count() { return arguments.length; } await f.notion.createPage({ parent: "p", title: String(count()) });'],
  ['a property name', 'const o = { arguments: 1 }; await f.notion.createPage({ parent: "p", title: String(o.arguments) });'],
])('does not refuse arguments belonging to %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it.each([
  ['parentheses', 'await (f.notion.appendBlock)("p", {});'],
  ['a comma expression', 'await (0, f.notion.appendBlock)("p", {});'],
  ['a logical fallback', 'await (f.notion.appendBlock || globalThis.noop)("p", {});'],
  ['new', 'new f.notion.appendBlock("p", {});'],
])('counts an appendBlock call through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a defaulted context parameter', "async function (f = {}) { await arguments[0].notion.appendBlock('p', {}); f.done('success'); }"],
  ['a destructured context parameter', "async function ({ done }) { await arguments[0].notion[globalThis.method]('p', {}); done('success'); }"],
])('refuses appendBlock reached through %s', async (_shape, fn) => {
  const path = fixture('', '{ tools: { notion: true } },');
  writeFileSync(path, `import { flow } from '@relayflows/surface';
export default flow('test', { tools: { notion: true } }, ${fn});`);
  const result = await check(path);
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a Symbol.toPrimitive hook', 'let held; Object.defineProperty(Object.prototype, Symbol.toPrimitive, { value() { held = this; return ""; }, configurable: true }); const s = `${f.notion}`; await held.appendBlock("p", {});'],
  ['__proto__ access', 'const proto = ({}).__proto__; proto.valueOf = function () { return this; }; await f.notion.createPage({ parent: "p", title: "t" });'],
  ['getPrototypeOf', 'Object.getPrototypeOf({}).hook = 1; await f.notion.createPage({ parent: "p", title: "t" });'],
  ['a Proxy', 'const p = new Proxy({}, {}); await f.notion.createPage({ parent: "p", title: String(p) });'],
])('refuses a body that tampers with prototypes through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('plain template interpolation without prototype tampering stays a read', async () => {
  const result = await check(fixture('const label = `${f.notion}`; await f.notion.createPage({ parent: "p", title: label });', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(0);
});
it('refuses prototype tampering hidden in a function that shadows the context name', async () => {
  const body = 'let held; function install(f) { Object.defineProperty(Object.prototype, Symbol.toPrimitive, { value() { held = this; return ""; }, configurable: true }); } install(); const s = `${f.notion}`; await held.appendBlock("p", {});';
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it.each([
  ['const Proxy', 'const Proxy = { label: "x" }; await f.notion.createPage({ parent: "p", title: Proxy.label });'],
  ['a shorthand of a local Reflect', 'const Reflect = 1; const o = { Reflect }; await f.notion.createPage({ parent: "p", title: String(o.Reflect) });'],
])('does not treat %s as prototype machinery', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it('refuses prototype machinery spelled with string-keyed members', async () => {
  const body = 'let held; Object["defineProperty"](Object["prototype"], Symbol["toPrimitive"], { value() { held = this; return ""; }, configurable: true }); const s = `${f.notion}`; await held.appendBlock("p", {});';
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it.each([
  ['a nested parameter named Proxy', 'function wrap(Proxy) { return Proxy; } const p = new Proxy({}, {}); await f.notion.createPage({ parent: "p", title: String(wrap(p)) });'],
  ['a catch binding named Reflect', 'try { throw 1; } catch (Reflect) { void Reflect; } await f.notion[Reflect.ownKeys({})[0] ?? "createPage"]({ parent: "p", title: "t" });'],
])('still refuses a global use when %s exists elsewhere', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it('scopes local machinery names: a parameter in one function does not hide the global in another', async () => {
  const local = await check(fixture('function wrap(Proxy) { return Proxy; } await f.notion.createPage({ parent: "p", title: String(wrap(1)) });', '{ tools: { notion: true } },'));
  expect(local.exit).toBe(0);
  const global = await check(fixture('function wrap(Proxy) { return Proxy; } const p = new Proxy({}, {}); wrap(p); await f.notion.createPage({ parent: "p", title: "t" });', '{ tools: { notion: true } },'));
  expect(global.exit).toBe(2);
});
it('a parameter named Function in one function does not hide new Function elsewhere', async () => {
  const result = await check(fixture('function wrap(Function) { return Function; } wrap(1); await new Function("n", "return n.appendBlock(\'p\', {})")(globalThis.helper);', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
it('refuses prototype machinery reached through destructuring', async () => {
  const body = 'let held; const { prototype: p } = Object; const { toPrimitive: t } = Symbol; p[t] = function () { held = this; return ""; }; const s = `${f.notion}`; await held.appendBlock("p", {});';
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
});
