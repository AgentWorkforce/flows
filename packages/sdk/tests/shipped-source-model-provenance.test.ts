import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { scanDeclarative } from './helpers/shipped-source-declarative-models.js';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

const MODELS: Record<string, ReadonlySet<string>> = {
  claude: new Set(['claude-sonnet-5', 'claude-opus-5']),
  codex: new Set(['gpt-5.6-sol']),
  'cursor-agent': new Set(['gpt-5.6-sol-high']),
  grok: new Set(['grok-4.7']),
};

function expectSupported(pair: string, where: string): void {
  const slash = pair.indexOf('/');
  const cli = pair.slice(0, slash);
  const model = pair.slice(slash + 1);
  expect(MODELS[cli], `${where}: disabled or unknown CLI ${cli}`).toBeDefined();
  expect(MODELS[cli]?.has(model), `${where}: unsupported pair ${pair}`).toBe(true);
}

describe('shipped-source model provenance', () => {
  it('does not treat mutable aliases or incomplete named agents as pinned', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-model-invariant-'));
    try {
      const mutable = join(directory, 'mutable.flow.ts');
      writeFileSync(mutable, `
        declare const f: { agent(name: string, options: { cli: string; model: string }): void };
        let cli = 'claude';
        var model = 'claude-sonnet-5';
        cli = 'grok'; model = 'grok-4.7';
        f.agent('mutable', { cli, model });
      `);
      const mutableResult = scanTypeScript(mutable);
      expect(mutableResult.pairs).toEqual([]);
      expect(mutableResult.unresolved.map(item => item.call)).toEqual(["'mutable'"]);

      const incomplete = join(directory, 'incomplete.flow.ts');
      writeFileSync(incomplete, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        declare const f: { agent(name: string, options: { task: string }): void };
        flow('incomplete', { agents: { reviewer: { cli: 'claude' } } }, () => {
          f.agent('reviewer', { task: 'review' });
        });
      `);
      const incompleteResult = scanTypeScript(incomplete);
      expect(incompleteResult.incompleteNamed).toHaveLength(1);
      expect(incompleteResult.missing).toHaveLength(1);

      const unusedNamedPolicy = join(directory, 'unused-named-policy.flow.ts');
      writeFileSync(unusedNamedPolicy, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        declare const f: { agent(name: string, options: { task: string }): void };
        const policy = { agents: { reviewer: { cli: 'claude', model: 'claude-sonnet-5' } } };
        void policy;
        flow('unrelated-policy', {}, () => f.agent('reviewer', { task: 'review' }));
      `);
      const unusedNamedPolicyResult = scanTypeScript(unusedNamedPolicy);
      expect(unusedNamedPolicyResult.namedPairs).toEqual([]);
      expect(unusedNamedPolicyResult.missing).toHaveLength(1);

      const incompleteLlm = join(directory, 'incomplete-llm.flow.ts');
      writeFileSync(incompleteLlm, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        declare const f: { llm(prompt: string, options: { cli: string }): void };
        flow('incomplete-llm', { budget: '$2' }, () => f.llm('triage', { cli: 'claude' }));
      `);
      const incompleteLlmResult = scanTypeScript(incompleteLlm);
      expect(incompleteLlmResult.calls).toBe(1);
      expect(incompleteLlmResult.missing).toHaveLength(1);
      expect(incompleteLlmResult.dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const looseBudget = join(directory, 'loose-budget.flow.ts');
      writeFileSync(looseBudget, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        flow('loose', { budget: { tokens: 20_000_000, dollars: 2 } }, () => {});
      `);
      expect(scanTypeScript(looseBudget).dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const boundedBudget = join(directory, 'bounded-budget.flow.ts');
      writeFileSync(boundedBudget, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        flow('bounded', { budget: { tokens: 200_000, dollars: 2 } }, () => {});
      `);
      expect(scanTypeScript(boundedBudget).dollarBudgetsWithoutTokenCeilings).toEqual([]);

      const shorthandBudget = join(directory, 'shorthand-budget.flow.ts');
      writeFileSync(shorthandBudget, `
        const tokens = 20_000_000;
        const dollars = 2;
        const budget = { tokens, dollars };
        declare function flow(name: string, header: unknown, body: () => void): void;
        flow('shorthand', { budget }, () => {});
      `);
      expect(scanTypeScript(shorthandBudget).dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const mutatedBudget = join(directory, 'mutated-budget.flow.ts');
      writeFileSync(mutatedBudget, `
        const budget = { tokens: 200_000, dollars: 2 };
        budget.tokens = 20_000_000;
        declare function flow(name: string, header: unknown, body: () => void): void;
        flow('mutated', { budget }, () => {});
      `);
      expect(scanTypeScript(mutatedBudget).dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const aliasedBudget = join(directory, 'aliased-budget.flow.ts');
      writeFileSync(aliasedBudget, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        const budget = { tokens: 200_000, dollars: 2 };
        const alias = { budget };
        alias.budget.tokens = 20_000_000;
        flow('mutated-through-alias', { budget }, () => {});
      `);
      expect(scanTypeScript(aliasedBudget).dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const conditionalBudget = join(directory, 'conditional-budget.flow.ts');
      writeFileSync(conditionalBudget, `
        declare const flag: boolean;
        declare function flow(name: string, header: unknown, body: () => void): void;
        const budget = flag
          ? { tokens: 20_000_000, dollars: 2 }
          : { tokens: 200_000, dollars: 2 };
        flow('conditional', { budget }, () => {});
      `);
      expect(scanTypeScript(conditionalBudget).dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const computedBudget = join(directory, 'computed-budget.flow.ts');
      writeFileSync(computedBudget, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        flow('computed', { budget: { ['dollars']: 2, tokens: 20_000_000 } }, () => {});
      `);
      expect(scanTypeScript(computedBudget).dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const aliasedHeader = join(directory, 'aliased-header.flow.ts');
      writeFileSync(aliasedHeader, `
        import * as surface from '@relayflows/surface'; declare const flag: boolean; declare function flow(name: string, header: unknown, body: () => void): void;
        const budget = { tokens: 200_000, dollars: 2 };
        const header = { budget }, box = { surface }, envelope: any = { nested: { surface } }, empty: any = {}, constructors: Array<typeof surface.flow | undefined> = [], namespaces: Array<typeof surface | undefined> = [], flowCalls: Array<typeof surface.flow.call | undefined> = [], flowApplies: Array<typeof surface.flow.apply | undefined> = [], aggregateConstructors = { define: surface.flow }, aggregateSlots = [surface.flow], nestedAggregateSlots = [{ define: surface.flow }], aggregateHelpers = { call: surface.flow.call, bind: surface.flow.bind, invoker: surface.flow.bind.call.bind(surface.flow.bind) }, cyclicAggregate: any = { define: cyclicAggregate.define }, flowKey = 'flow' as const, defineKey = 'define' as const, computedConstructors = { [defineKey]: surface.flow }, computedNumericConstructors = { [0]: surface.flow }, spreadConstructors = { ...{ define: surface.flow } }, spreadSlots = [...[surface.flow]], spreadHelpers = { ...{ call: surface.flow.call } }, wrappedSpreadConstructors = { ...(flag ? { define: surface.flow } : { define: surface.flow }) }, wrappedSpreadSlots = [...(flag ? [surface.flow] : [surface.flow])], numericConstructors = { 0: surface.flow }, stringSlots = [surface.flow]; const { surface: nested, surface: { flow: defineNested } } = box; const { nested: { surface: deepNested } } = envelope; const { surface: defaultNamespace = surface } = empty; const { surface: { flow: defaultConstructor = surface.flow } = {}, nested: { flow: outerDefaultConstructor } = surface, pack: [nestedArrayConstructor] = [surface.flow], helperPack: [defaultBindHelper] = [surface.flow.bind], invokerPack: [defaultBindInvoker] = [surface.flow.bind.call.bind(surface.flow.bind)] } = empty; const [arrayConstructor = surface.flow] = constructors; const [arrayNamespace = surface] = namespaces; const [directArrayConstructor, directArrayNamespace] = [surface.flow, surface]; const [defaultFlowCall = surface.flow.call] = flowCalls; const [defaultFlowApply = surface.flow.apply] = flowApplies; const { bindingConstructors } = { bindingConstructors: { define: surface.flow } }; const { bindingSlots } = { bindingSlots: [surface.flow] }; const { ...restConstructors } = { define: surface.flow }; const [, ...restSlots] = [undefined, surface.flow];
        header.budget.tokens = 20_000_000;
        flow('mutated-through-header', header, () => {}); box.surface.flow('nested-namespace', { budget: '$2' }, () => {}); nested.flow('destructured-namespace', { budget: '$2' }, () => {}); deepNested.flow('deep-destructured-namespace', { budget: '$2' }, () => {}); defineNested('nested-flow-binding', { budget: '$2' }, () => {}); defaultNamespace.flow('default-namespace', { budget: '$2' }, () => {}); defaultConstructor('default-constructor', { budget: '$2' }, () => {}); outerDefaultConstructor('outer-default-constructor', { budget: '$2' }, () => {}); nestedArrayConstructor('nested-array-constructor', { budget: '$2' }, () => {}); defaultBindHelper.call(surface.flow, undefined, 'default-bind-helper')({ budget: '$2' }, () => {}); defaultBindInvoker(surface.flow.bind, surface.flow, undefined, 'default-bind-invoker')({ budget: '$2' }, () => {}); arrayConstructor('array-constructor', { budget: '$2' }, () => {}); arrayNamespace.flow('array-namespace', { budget: '$2' }, () => {}); directArrayConstructor('direct-array-constructor', { budget: '$2' }, () => {}); directArrayNamespace.flow('direct-array-namespace', { budget: '$2' }, () => {}); defaultFlowCall(surface.flow, 'default-flow-call', { budget: '$2' }, () => {}); defaultFlowApply(surface.flow, ['default-flow-apply', { budget: '$2' }, () => {}]);
        aggregateConstructors.define('aggregate-object-constructor', { budget: '$2' }, () => {});
        aggregateSlots[0]('aggregate-array-constructor', { budget: '$2' }, () => {});
        nestedAggregateSlots[0].define('nested-aggregate-constructor', { budget: '$2' }, () => {});
        aggregateHelpers.call(surface.flow, 'aggregate-call-helper', { budget: '$2' }, () => {});
        aggregateHelpers.bind.call(surface.flow, undefined, 'aggregate-bind-helper')({ budget: '$2' }, () => {});
        aggregateHelpers.invoker(surface.flow.bind, surface.flow, undefined, 'aggregate-bind-invoker')({ budget: '$2' }, () => {});
        cyclicAggregate.define('cyclic-aggregate-constructor', { budget: '$2' }, () => {});
        surface[flowKey]('computed-flow-member', header, () => {});
        computedConstructors[defineKey]('computed-aggregate-constructor', { budget: '$2' }, () => {});
        spreadConstructors.define('object-spread-constructor', { budget: '$2' }, () => {});
        spreadSlots[0]('array-spread-constructor', { budget: '$2' }, () => {});
        spreadHelpers.call(surface.flow, 'spread-call-helper', { budget: '$2' }, () => {});
        bindingConstructors.define('binding-object-constructor', { budget: '$2' }, () => {});
        bindingSlots[0]('binding-array-constructor', { budget: '$2' }, () => {});
        wrappedSpreadConstructors.define('wrapped-object-spread-constructor', { budget: '$2' }, () => {});
        wrappedSpreadSlots[0]('wrapped-array-spread-constructor', { budget: '$2' }, () => {});
        restConstructors.define('object-rest-constructor', { budget: '$2' }, () => {});
        restSlots[0]('array-rest-constructor', { budget: '$2' }, () => {});
        numericConstructors[0]('numeric-object-constructor', { budget: '$2' }, () => {});
        computedNumericConstructors[0]('computed-numeric-object-constructor', { budget: '$2' }, () => {});
        stringSlots['0']('string-array-constructor', { budget: '$2' }, () => {});
        (function unknownArraySpreadConstructor(extras: unknown[]) { const slots = [surface.flow, ...extras]; slots[0]('unknown-array-spread-constructor', { budget: '$2' }, () => {}); })([]);
        (function unknownComputedOverwriteConstructor(key: string) { const constructors = { define: surface.flow, [key]: () => undefined }; constructors.define('unknown-computed-constructor', { budget: '$2' }, () => {}); })('other');
        (function defaultedArrayRestConstructor(sources: any[]) { const [, ...constructors = [surface.flow]] = sources; constructors[0]('defaulted-array-rest-constructor', { budget: '$2' }, () => {}); })([]);
        { const [, ...[nestedRestConstructor]] = [undefined, surface.flow]; nestedRestConstructor('nested-array-rest-constructor', { budget: '$2' }, () => {}); }
        { const [, ...{ 0: nestedObjectRestConstructor }] = [undefined, surface.flow]; nestedObjectRestConstructor('nested-object-under-array-rest-constructor', { budget: '$2' }, () => {}); }
        (function defaultedNestedObjectRestConstructor(sources: any[]) { const [, ...{ 0: define } = [surface.flow]] = sources; define('defaulted-nested-object-under-array-rest-constructor', { budget: '$2' }, () => {}); })([]);
        (function outerDefaultArrayRestConstructor(source: any) { const { pack: [, ...constructors] = [undefined, surface.flow] } = source; constructors[0]('outer-default-array-rest-constructor', { budget: '$2' }, () => {}); })({});
        surface.flow.call.call(surface.flow, surface, 'recursive-call-helper', { budget: '$2' }, () => {});
        surface.flow.apply.call(surface.flow, surface, ['recursive-apply-helper', { budget: '$2' }, () => {}]);
        Reflect.apply(surface.flow, surface, ['reflect-apply-constructor', { budget: '$2' }, () => {}]);
        { const apply = Reflect.apply; apply(surface.flow, surface, ['aliased-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        { const R = Reflect; R.apply(surface.flow, surface, ['aliased-reflect-constructor', { budget: '$2' }, () => {}]); }
        { const { apply } = Reflect; apply(surface.flow, surface, ['destructured-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        { const key = 'apply' as const; const { [key]: apply } = Reflect; apply(surface.flow, surface, ['computed-destructured-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        Reflect.apply.call(Reflect, surface.flow, surface, ['called-reflect-apply-constructor', { budget: '$2' }, () => {}]);
        Reflect.apply.apply(Reflect, [surface.flow, surface, ['applied-reflect-apply-constructor', { budget: '$2' }, () => {}]]);
        Reflect.apply(...[surface.flow, surface, ['spread-reflect-apply-constructor', { budget: '$2' }, () => {}]] as const);
        Reflect.apply.bind(Reflect)(surface.flow, surface, ['bound-reflect-apply-constructor', { budget: '$2' }, () => {}]);
        { const invoke = Reflect.apply.bind(Reflect, surface.flow, surface); invoke(['prebound-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        { const invoke = Reflect.apply.call.bind(Reflect.apply); invoke(Reflect, surface.flow, surface, ['composed-called-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        { const invoke = Reflect.apply.apply.bind(Reflect.apply); invoke(Reflect, [surface.flow, surface, ['composed-applied-reflect-apply-constructor', { budget: '$2' }, () => {}]]); }
        Reflect.apply.call.call(Reflect.apply, Reflect, surface.flow, surface, ['recursive-reflect-apply-call-constructor', { budget: '$2' }, () => {}]);
        Reflect.apply(Reflect.apply, Reflect, [surface.flow, surface, ['nested-reflect-apply-constructor', { budget: '$2' }, () => {}]]);
        { const invoke = Reflect.apply.bind(Reflect, surface.flow); invoke.call(null, surface, ['prebound-called-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        { const invoke = Reflect.apply.bind(Reflect, surface.flow); invoke.apply(null, [surface, ['prebound-applied-reflect-apply-constructor', { budget: '$2' }, () => {}]]); }
        { let helper: any; helper = { invoke: Reflect.apply }; helper.invoke(surface.flow, surface, ['overwritten-aggregate-reflect-apply-constructor', { budget: '$2' }, () => {}]); helper = { invoke: () => undefined }; }
        { let helper: any; helper = { invoke: Reflect.apply.call.bind(Reflect.apply) }; helper.invoke(Reflect, surface.flow, surface, ['overwritten-composed-reflect-apply-constructor', { budget: '$2' }, () => {}]); helper = { invoke: Reflect.apply }; }
        globalThis.Reflect.apply(surface.flow, surface, ['global-this-reflect-apply-constructor', { budget: '$2' }, () => {}]);
        { let apply: any; ({ apply } = Reflect); apply(surface.flow, surface, ['assigned-destructured-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        { const key = 'apply' as const; let apply: any; ({ [key]: apply } = Reflect); apply(surface.flow, surface, ['assigned-computed-reflect-apply-constructor', { budget: '$2' }, () => {}]); }
        { const invoke = (define: (...args: any[]) => void, ...args: any[]) => define(...args); invoke(surface.flow, 'forwarded-constructor', { budget: '$2' }, () => {}); }
        { const invoke = (define: (...args: any[]) => void, ...args: any[]) => define(...args); invoke(...[surface.flow, 'spread-forwarded-constructor', { budget: '$2' }, () => {}] as const); }
        { let assigned: any = () => undefined; assigned = surface.flow; assigned('assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any = () => undefined; (assigned as any) = surface.flow; assigned('wrapped-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any; assigned ||= surface.flow; assigned('or-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any = () => undefined; assigned &&= surface.flow; assigned('and-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any; assigned ??= surface.flow; assigned('nullish-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any; ({ assigned } = { assigned: surface.flow }); assigned('object-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any; [assigned] = [surface.flow]; assigned('array-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any; ({ assigned = surface.flow } = {}); assigned('defaulted-object-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any; [assigned = surface.flow] = []; assigned('defaulted-array-assigned-constructor', { budget: '$2' }, () => {}); }
        { let constructors: any; [, ...constructors] = [undefined, surface.flow]; constructors[0]('array-rest-assigned-constructor', { budget: '$2' }, () => {}); }
        { let assigned: any; [, ...[assigned]] = [undefined, surface.flow]; assigned('nested-array-rest-assigned-constructor', { budget: '$2' }, () => {}); }
        { let constructors: any; [, ...[, ...constructors]] = [undefined, undefined, surface.flow]; constructors[0]('doubly-nested-array-rest-assigned-constructor', { budget: '$2' }, () => {}); }
        { let constructors: any; ({ ...constructors } = { define: surface.flow }); constructors.define('object-rest-assigned-constructor', { budget: '$2' }, () => {}); }
        { let constructor: any; constructor = { define: () => undefined }; constructor = { define: surface.flow }; constructor.define('later-object-assigned-constructor', { budget: '$2' }, () => {}); }
        { let constructors: any; [...constructors] = [() => undefined]; [...constructors] = [surface.flow]; constructors[0]('later-array-rest-assigned-constructor', { budget: '$2' }, () => {}); }
        { let constructor: any; constructor = { define: surface.flow }; constructor.define('later-safe-object-assigned-constructor', { budget: '$2' }, () => {}); constructor = { define: () => undefined }; }
        { let constructors: any; [...constructors] = [surface.flow]; constructors[0]('later-safe-array-rest-assigned-constructor', { budget: '$2' }, () => {}); [...constructors] = [() => undefined]; }
        { let constructor: any; if (flag) constructor = { define: surface.flow }; else constructor = { define: () => undefined }; constructor.define('branched-object-assigned-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; box.define = surface.flow; box.define('member-assigned-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; box.worker = { define: surface.flow }; box.worker.define('nested-member-assigned-constructor', { budget: '$2' }, () => {}); }
        { const slots: any[] = []; slots[0] = surface.flow; slots[0]('element-assigned-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; ({ define: box.define } = { define: surface.flow }); box.define('object-pattern-member-assigned-constructor', { budget: '$2' }, () => {}); }
        { const slots: any[] = []; [slots[0]] = [surface.flow]; slots[0]('array-pattern-member-assigned-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.assign(box, { define: surface.flow }); box.define('object-assign-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.set(box, 'define', surface.flow); box.define('reflect-set-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.assign.call(Object, box, { define: surface.flow }); box.define('object-assign-call-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.assign.apply(Object, [box, { define: surface.flow }]); box.define('object-assign-apply-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.assign.bind(Object)(box, { define: surface.flow }); box.define('object-assign-bind-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.set.call(Reflect, box, 'define', surface.flow); box.define('reflect-set-call-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.set.apply(Reflect, [box, 'define', surface.flow]); box.define('reflect-set-apply-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.set.bind(Reflect)(box, 'define', surface.flow); box.define('reflect-set-bind-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.apply(Object.assign, Object, [box, { define: surface.flow }]); box.define('reflect-apply-object-assign-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.apply(Reflect.set, Reflect, [box, 'define', surface.flow]); box.define('reflect-apply-reflect-set-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, helpers = { assign: Object.assign }; helpers.assign(box, { define: surface.flow }); box.define('aggregate-object-assign-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, helpers: any = {}; helpers.assign = Object.assign; helpers.assign(box, { define: surface.flow }); box.define('member-assigned-object-assign-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, assigners: Array<typeof Object.assign | undefined> = []; const [assign = Object.assign] = assigners; assign(box, { define: surface.flow }); box.define('defaulted-object-assign-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; let assign: any; ({ assign } = Object); assign(box, { define: surface.flow }); box.define('assigned-destructured-object-assign-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, assign = Object.assign.bind(Object); assign(box, { define: surface.flow }); box.define('bound-object-assign-alias-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, descriptors = { define: { value: surface.flow } }; Object.defineProperties(box, descriptors); box.define('aliased-define-properties-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, maps: any = {}; maps.descriptors = { define: { value: surface.flow } }; Object.defineProperties(box, maps.descriptors); box.define('member-assigned-define-properties-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, descriptors = { ...{ define: { value: surface.flow } } }; Object.defineProperties(box, descriptors); box.define('spread-define-properties-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, alias = box; Object.assign(alias, { define: surface.flow }); box.define('aliased-reflective-target-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; const identity = (value: any) => value; Object.assign(identity(box), { define: surface.flow }); box.define('returned-reflective-target-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; function identity(value: any) { const alias = value; return alias; } Object.assign(identity(box), { define: surface.flow }); box.define('returned-const-alias-reflective-target-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; function identity(value: any) { let alias; alias = value; return alias; } Object.assign(identity(box), { define: surface.flow }); box.define('returned-assigned-alias-reflective-target-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; function identity(value: any) { return flag ? value : value; } Object.assign(identity(box), { define: surface.flow }); box.define('returned-wrapped-reflective-target-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; function getBox() { return box; } Object.assign(getBox(), { define: surface.flow }); box.define('captured-reflective-target-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.assign.apply(Object, flag ? [box, { define: () => undefined }] : [box, { define: surface.flow }]); box.define('branched-apply-reflective-writer-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, extras: any[] = []; Object.assign(box, { define: surface.flow }, ...extras); box.define('spread-reflective-writer-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, extras: any[] = []; Object.assign.apply(Object, [box, ...extras, { define: surface.flow }]); box.define('spread-apply-reflective-writer-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, extras: any[] = []; Reflect.apply(Object.assign, Object, [box, ...extras, { define: surface.flow }]); box.define('spread-reflect-apply-reflective-writer-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = { get define() { return surface.flow; } }; box.define('object-getter-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = { get define() { return surface.flow; }, set define(value: any) {} }; box.define('paired-accessor-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = { get define() { if (flag) return () => undefined; return surface.flow; } }; box.define('branched-object-getter-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.defineProperty(box, 'define', { get() { return surface.flow; } }); box.define('define-property-getter-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}, getter = () => surface.flow; Object.defineProperty(box, 'define', { get: getter }); box.define('aliased-define-property-getter-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.defineProperties(box, { define: { get() { return surface.flow; } } }); box.define('define-properties-getter-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; [...[box.constructors]] = [[surface.flow]]; box.constructors[0]('nested-rest-member-assigned-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; [...box.constructors] = [surface.flow]; box.constructors[0]('array-rest-member-assigned-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; ({ ...box.constructors } = { define: surface.flow }); box.constructors.define('object-rest-member-assigned-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.defineProperty(box, 'define', { value: surface.flow }); box.define('object-define-property-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.defineProperties(box, { define: { value: surface.flow } }); box.define('object-define-properties-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Object.setPrototypeOf(box, { define: surface.flow }); box.define('object-set-prototype-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.defineProperty(box, 'define', { value: surface.flow }); box.define('reflect-define-property-member-constructor', { budget: '$2' }, () => {}); }
        { const box: any = {}; Reflect.setPrototypeOf(box, { define: surface.flow }); box.define('reflect-set-prototype-member-constructor', { budget: '$2' }, () => {}); }
        { let { constructors } = { constructors: { define: () => undefined } }; ({ constructors } = { constructors: { define: surface.flow } }); constructors.define('reassigned-object-binding-constructor', { budget: '$2' }, () => {}); }
        { let [constructors] = [[() => undefined]]; [constructors] = [[surface.flow]]; constructors[0]('reassigned-array-binding-constructor', { budget: '$2' }, () => {}); }
        { let { assigned } = { assigned: () => undefined }; assigned = surface.flow; assigned('assigned-destructured-constructor', { budget: '$2' }, () => {}); }
        { const original = 'flow' as const, key = original; const { [key]: define } = surface; define('renamed-computed-destructured-constructor', { budget: '$2' }, () => {}); }
        { const { key } = { key: 'flow' as const }; const { [key]: define } = surface; define('binding-computed-destructured-constructor', { budget: '$2' }, () => {}); }
        { const key = (flag && 'flow') || 'flow'; const { [key]: define } = surface; define('logical-computed-destructured-constructor', { budget: '$2' }, () => {}); }
        { const key = 'flow' as const; const { [key]: { [key]: define } } = { flow: { flow: surface.flow } }; define('nested-computed-destructured-constructor', { budget: '$2' }, () => {}); }
        async function wrappedFlowAliases() { const conditionalDefine = flag ? surface.flow : surface.flow, logicalDefine = (flag && surface.flow) || surface.flow, nullishDefine = surface.flow ?? surface.flow, commaDefine = (flag, surface.flow), awaitDefine = await surface.flow; conditionalDefine('conditional-flow', { budget: '$2' }, () => {}); logicalDefine('logical-flow', { budget: '$2' }, () => {}); nullishDefine('nullish-flow', { budget: '$2' }, () => {}); commaDefine('comma-flow', { budget: '$2' }, () => {}); awaitDefine('await-flow', { budget: '$2' }, () => {}); }
      `);
      expect(scanTypeScript(aliasedHeader).invalidFlowHeaders).toHaveLength(146);
      const repairedFlowCases = [
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
      for (const [index, candidate] of repairedFlowCases.entries()) {
        const repairedFlow = join(directory, `repaired-flow-${index}.flow.ts`);
        writeFileSync(repairedFlow, `import * as surface from '@relayflows/surface'; declare const flag: boolean; ${candidate}`);
        expect(scanTypeScript(repairedFlow).invalidFlowHeaders, candidate).toHaveLength(1);
      }
      const formalAndReceiverRepairs = join(directory, 'formal-and-receiver-repairs.flow.ts');
      writeFileSync(formalAndReceiverRepairs, `
        import * as surface from '@relayflows/surface';
        declare const flag: boolean;
        { const box: any = {}; function id(value: any = box) { return value; } Object.assign(id(undefined), { define: surface.flow }); box.define('explicit-undefined-default', { budget: '$2' }, () => {}); }
        { const box: any = { nested: {} }; function id(...values: any[]) { return values['0'].nested; } Object.assign(id(box), { define: surface.flow }); box.nested.define('rest-member-formal', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest[0]; } Object.assign(id([undefined, box]), { define: surface.flow }); box.define('array-rest-formal', { budget: '$2' }, () => {}); }
        { const box: any = {}, other: any = {}; function id(value: any) { return value; } Object.assign(id(...(flag ? [other] : [box])), { define: surface.flow }); box.define('alternate-spread-actual', { budget: '$2' }, () => {}); }
        { const box: any = {}; let alias: any; alias = box; alias.define = surface.flow; box.define('assigned-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}, alias = flag ? box : box; alias.define = surface.flow; box.define('wrapped-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}, holder = { alias: box }; holder.alias.define = surface.flow; box.define('object-member-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}, holder = [box]; holder[0].define = surface.flow; box.define('array-member-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}; const { alias } = { alias: box }; alias.define = surface.flow; box.define('binding-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}; let alias: any; ({ alias } = { alias: box }); alias.define = surface.flow; box.define('assigned-binding-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}, holder = { alias: box }; Object.assign(holder.alias, { define: surface.flow }); box.define('reflective-member-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}; let key: string; key = 'define'; box[key] = surface.flow; box.define('assigned-direct-key', { budget: '$2' }, () => {}); }
      `);
      expect(scanTypeScript(formalAndReceiverRepairs).invalidFlowHeaders).toHaveLength(12);
      const computedBindingCases = [
        `{ const original = 'flow' as const, key = original; const { [key]: define } = surface; define('renamed', { budget: '$2' }, () => {}); }`,
        `{ const { key } = { key: 'flow' as const }; const { [key]: define } = surface; define('binding', { budget: '$2' }, () => {}); }`,
        `{ const key = (flag && 'flow') || 'flow'; const { [key]: define } = surface; define('logical', { budget: '$2' }, () => {}); }`,
        `{ const key = 'flow' as const; const { [key]: { [key]: define } } = { flow: { flow: surface.flow } }; define('nested', { budget: '$2' }, () => {}); }`,
      ];
      for (const [index, candidate] of computedBindingCases.entries()) {
        const computedBinding = join(directory, `computed-binding-${index}.flow.ts`);
        writeFileSync(computedBinding, `import * as surface from '@relayflows/surface'; declare const flag: boolean; ${candidate}`);
        expect(scanTypeScript(computedBinding).invalidFlowHeaders, candidate).toHaveLength(1);
      }

      const twoArgumentBudget = join(directory, 'two-argument-budget.flow.ts');
      writeFileSync(twoArgumentBudget, `
        declare function flow(name: string, header: unknown): unknown;
        flow('scheduled', { budget: '$2' });
      `);
      expect(scanTypeScript(twoArgumentBudget).dollarBudgetsWithoutTokenCeilings).toHaveLength(1);

      const spreadHeader = join(directory, 'spread-header.flow.ts');
      writeFileSync(spreadHeader, `
        declare function flow(name: string, header: unknown, body: () => void): void;
        const policy = { budget: '$2' };
        flow('spread', { ...policy }, () => {});
      `);
      expect(scanTypeScript(spreadHeader).invalidFlowHeaders).toHaveLength(1);

      const unsafeFlowHeaders = join(directory, 'unsafe-flow-headers.flow.ts');
      writeFileSync(unsafeFlowHeaders, `
        import { flow as importedFlow } from '@relayflows/surface';
        import * as surface from '@relayflows/surface';
        declare const flowArgs: [string, unknown, () => void], bindArgs: [undefined, string], callArgs: [undefined, string, unknown, () => void], receiverArgs: [undefined];
        declare function flow(name: string, header: unknown, body: () => void): void;
        const define = flow, baseFlow = flow, bound = flow.bind(undefined), helper = flow.call, applyHelper = flow.apply, helperBound = helper.bind(flow, undefined), bindFlow = flow.bind, invokeBind = bindFlow.call.bind(bindFlow), api = surface; const { flow: destructured, ['flow']: computed } = surface; let mutableFlow = flow, mutableHelper = flow.call, mutableApi = surface;
        const preboundName = flow.bind(undefined, 'prebound-name'), preboundHeader = flow.bind(undefined, 'prebound-header', { budget: '$2' }), reboundHeader = bindFlow.call(preboundHeader, undefined, 'ignored', { budget: { dollars: 2, tokens: 200_000 } }), extractedBound = bindFlow.call(flow, undefined, 'extracted'), twiceBound = invokeBind(flow, undefined, 'twice');
        define('aliased', { budget: '$2' }, () => {}); bound('bound', { budget: '$2' }, () => {}); destructured('destructured', { budget: '$2' }, () => {}); mutableFlow('mutable', { budget: '$2' }, () => {}); mutableHelper(undefined, 'mutable-helper', { budget: '$2' }, () => {}); mutableApi.flow('mutable-api', { budget: '$2' }, () => {});
        preboundName({ budget: '$2' }, () => {}); preboundHeader(() => {}); reboundHeader(() => {}); helper(undefined, 'helper', { budget: '$2' }, () => {}); applyHelper(undefined, ['apply-helper', { budget: '$2' }, () => {}]); helperBound('helper-bound', { budget: '$2' }, () => {});
        importedFlow('imported', { budget: '$2' }, () => {}); api.flow('namespace-alias', { budget: '$2' }, () => {}); computed('computed-binding', { budget: '$2' }, () => {}); extractedBound({ budget: '$2' }, () => {}); twiceBound({ budget: '$2' }, () => {}); { let flow = baseFlow; flow = baseFlow.bind(undefined, 'shadowed', { budget: '$2' }); flow(() => {}); }
        surface.flow('namespace', { budget: '$2' }, () => {}); surface.flow.call(undefined, 'called', { budget: '$2' }, () => {}); surface.flow.apply(undefined, ['applied', { budget: '$2' }, () => {}]); surface.flow.apply(undefined, [] as unknown as []);
        surface.flow.call(undefined, ...flowArgs); surface.flow.apply(undefined, [...flowArgs]); flow.bind(...bindArgs)({ budget: '$2' }, () => {}); flow.call(...callArgs); flow.apply(...receiverArgs, ['outer-applied', { budget: '$2' }, () => {}]);
        flow('accessor', { get budget() { return { dollars: 2, tokens: 20_000_000 }; } }, () => {});
        flow('duplicate', { budget: '$2', budget: '$1' }, () => {});
      `);
      const unsafeFlowHeaderResult = scanTypeScript(unsafeFlowHeaders);
      expect(unsafeFlowHeaderResult.dollarBudgetsWithoutTokenCeilings).toHaveLength(17);
      expect(unsafeFlowHeaderResult.invalidFlowHeaders).toHaveLength(12);

      const namedBody = join(directory, 'named-body.flow.ts');
      writeFileSync(namedBody, `
        declare function flow(name: string, body: () => void): void;
        const body = () => {};
        flow('body', body);
      `);
      expect(scanTypeScript(namedBody).invalidFlowHeaders).toEqual([]);

      const spreadPins = join(directory, 'spread-pins.flow.ts');
      writeFileSync(spreadPins, `
        declare const override: object;
        declare const f: { agent(name: string, options: object): void };
        declare function flow(name: string, header: object, body: () => void): void;
        flow('spread-pins', { agents: {
          reviewer: { cli: 'claude', model: 'claude-sonnet-5', ...override },
          duplicate: { cli: 'claude', cli: 'codex', model: 'claude-sonnet-5' },
        } }, () => f.agent('reviewer', {
          cli: 'claude', model: 'claude-sonnet-5', task: 'x', ...override,
        }));
        f.agent('duplicate', { cli: 'claude', model: 'claude-sonnet-5', model: 'gpt-5.6-sol' });
      `);
      const spreadPinResult = scanTypeScript(spreadPins);
      expect(spreadPinResult.incompleteNamed).toHaveLength(2);
      expect(spreadPinResult.missing).toHaveLength(2);

      const taggedLlm = join(directory, 'tagged-llm.flow.ts');
      writeFileSync(taggedLlm, `
        declare const f: { llm(strings: TemplateStringsArray): void };
        f.llm\`triage\`;
      `);
      const taggedLlmResult = scanTypeScript(taggedLlm);
      expect(taggedLlmResult.calls).toBe(1);
      expect(taggedLlmResult.missing).toEqual([
        expect.stringContaining('tagged f.llm has no explicit CLI/model options'),
      ]);

      const declarativeLlm = scanDeclarative(parse(`
        version: 0.1.0
        cli: claude
        steps:
          - id: missing-model
            type: llm
            prompt: triage
          - id: unsupported-model
            type: llm
            model: not-a-model
            prompt: triage
      `) as Record<string, unknown>, 'mutation.flow.yaml');
      expect(declarativeLlm.calls).toBe(2);
      expect(declarativeLlm.missing).toEqual(['mutation.flow.yaml:missing-model has no explicit model']);
      expect(() => declarativeLlm.pairs.forEach(pair => expectSupported(pair, 'mutation.flow.yaml')))
        .toThrow('unsupported pair');

      const activeV1 = scanDeclarative(parse(`
        version: '1.0'
        agents:
          - name: lead
            cli: claude
        workflows:
          - name: drive
            steps:
              - name: assess
                type: agent
                agent: lead
      `) as Record<string, unknown>, 'drive-cloud.yaml');
      expect(activeV1.calls).toBe(1);
      expect(activeV1.missing).toEqual([
        'drive-cloud.yaml:agent:lead has no explicit model',
        'drive-cloud.yaml:assess has no explicit model',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
