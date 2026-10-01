import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

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
        { const box: any = {}, other: any = {}; let alias: any = other; alias = box; alias.define = surface.flow; box.define('initialized-assigned-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; let alias: any = null; alias ||= box; alias.define = surface.flow; box.define('initialized-logical-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; let holder: any = {}; holder = { alias: box }; holder.alias.define = surface.flow; box.define('assigned-holder-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}, holder: any = {}; holder.alias = box; holder.alias.define = surface.flow; box.define('assigned-member-receiver', { budget: '$2' }, () => {}); }
        { const holder: any = { alias: {} }; const { alias } = holder; alias.define = surface.flow; holder.alias.define('binding-parent-path', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(...[{ value }]: any[]) { return value; } Object.assign(id({ value: box }), { define: surface.flow }); box.define('rest-object-pattern', { budget: '$2' }, () => {}); }
        { const box: any = { nested: {} }; function id(...[{ value }]: any[]) { return value.nested; } Object.assign(id({ value: box }), { define: surface.flow }); box.nested.define('rest-object-pattern-suffix', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(...[[value]]: any[]) { return value; } Object.assign(id([box]), { define: surface.flow }); box.define('rest-array-pattern', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(...[skip, value]: any[]) { return value; } Object.assign(id(undefined, box), { define: surface.flow }); box.define('rest-pattern-index', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...[unused, ...rest]]: any[]) { return rest[0]; } Object.assign(id([undefined, undefined, box]), { define: surface.flow }); box.define('nested-rest-offset', { budget: '$2' }, () => {}); }
        { const box: any = {}; let key: string; key = 'define'; box[key] = surface.flow; key = 'other'; box.define('temporal-assigned-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; let key: string; ({ key } = { key: 'define' }); box[key] = surface.flow; box.define('object-assigned-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; let key: string; [key] = ['define']; box[key] = surface.flow; box.define('array-assigned-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; let key: string; if (flag) key = 'define'; else key = 'other'; box[key] = surface.flow; box.define('branched-assigned-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } const alias = id(box); alias.define = surface.flow; box.define('local-call-receiver-alias', { budget: '$2' }, () => {}); }
        { const box: any = {}, keys: any = {}; keys.value = 'define'; box[keys.value] = surface.flow; box.define('member-held-direct-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(...[skip, ...[value]]: any[]) { return value; } Object.assign(id(undefined, box), { define: surface.flow }); box.define('nested-rest-direct-binding', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(...[[skip, ...rest]]: any[]) { return rest[0]; } Object.assign(id([undefined, box]), { define: surface.flow }); box.define('nested-rest-array-prefix', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(...[{ items: [skip, ...rest] }]: any[]) { return rest[0]; } Object.assign(id({ items: [undefined, box] }), { define: surface.flow }); box.define('nested-rest-object-prefix', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(...[[skip, ...[value]]]: any[]) { return value; } Object.assign(id([undefined, box]), { define: surface.flow }); box.define('nested-rest-prefixed-binding', { budget: '$2' }, () => {}); }
        { const box: any = {}, keys: any = {}; keys.a = 'define'; keys.a = keys.b; keys.b = keys.a; box[keys.a] = surface.flow; box.define('cyclic-member-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } (flag ? id(box) : id(box)).define = surface.flow; box.define('conditional-local-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } ((flag && id(box)) || id(box)).define = surface.flow; box.define('logical-local-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } async function repair() { (await id(box)).define = surface.flow; box.define('await-local-call-receiver', { budget: '$2' }, () => {}); } repair(); }
        { const box: any = {}, holder = { keys: { value: 'define' as const } }; box[holder.keys.value] = surface.flow; box.define('nested-aggregate-held-key', { budget: '$2' }, () => {}); }
        { const box: any = {}, keys: any = {}; keys.b = 'define'; keys.a = keys.b; box[keys.a] = surface.flow; box.define('sibling-member-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } Object.assign(id([undefined, box])[0], { define: surface.flow }); box.define('returned-rest-container', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; (alias = id(box)).define = surface.flow; box.define('assignment-local-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; (alias ||= id(box)).define = surface.flow; box.define('logical-assignment-local-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key() { return 'define' as const; } box[key()] = surface.flow; box.define('local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id({ skip, ...rest }: any) { return rest; } Object.assign(id({ skip: 0, value: box }).value, { define: surface.flow }); box.define('returned-object-rest-container', { budget: '$2' }, () => {}); }
        { const box: any = {}, holder = { keys: flag ? { value: 'other' as const } : { value: 'define' as const } }; box[holder.keys.value] = surface.flow; box.define('branched-nested-aggregate-key', { budget: '$2' }, () => {}); }
        { const box: any = {}, holder = { keys: { value: 'define' as const } }; function get() { return holder; } box[get().keys.value] = surface.flow; box.define('local-call-nested-key-root', { budget: '$2' }, () => {}); }
        { const box: any = {}, first = { keys: { value: 'other' as const } }, second = { keys: { value: 'define' as const } }; box[(flag ? first : second).keys.value] = surface.flow; box.define('branched-nested-key-root', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } const chosen = id([undefined, box]); chosen[0].define = surface.flow; box.define('aliased-array-rest-container', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } const chosen = id([undefined, box]); Object.assign(chosen[0], { define: surface.flow }); box.define('reflective-aliased-array-rest-container', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id({ skip, ...rest }: any) { return rest; } const chosen = id({ skip: 0, value: box }); chosen.value.define = surface.flow; box.define('aliased-object-rest-container', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id({ skip, ...rest }: any) { return rest; } const chosen = id({ skip: 0, value: box }); Object.assign(chosen.value, { define: surface.flow }); box.define('reflective-aliased-object-rest-container', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } (flag ? id([undefined, box]) : id([undefined, box]))[0].define = surface.flow; box.define('conditional-rest-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } Object.assign((flag ? id([undefined, box]) : id([undefined, box]))[0], { define: surface.flow }); box.define('reflective-conditional-rest-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } ((flag && id([undefined, box])) || id([undefined, box]))[0].define = surface.flow; box.define('logical-rest-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } async function repair() { (await id([undefined, box]))[0].define = surface.flow; box.define('await-rest-call-receiver', { budget: '$2' }, () => {}); } repair(); }
        { const box: any = {}, keys: any = {}; keys.a = { b: 'define' }; keys['a/string:b'] = keys.a.b; box[keys['a/string:b']] = surface.flow; box.define('collision-free-member-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { return value; } box[key('define')] = surface.flow; box.define('parameter-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { return value.name; } box[key({ name: 'define' })] = surface.flow; box.define('member-parameter-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any = 'define') { return value; } box[key(undefined)] = surface.flow; box.define('default-parameter-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(...values: any[]) { return values[0]; } box[key('define')] = surface.flow; box.define('rest-parameter-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key({ name }: any) { return name; } box[key({ name: 'define' })] = surface.flow; box.define('object-binding-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key([skip, ...rest]: any[]) { return rest[0]; } box[key([undefined, 'define'])] = surface.flow; box.define('array-rest-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; Object.assign((alias = id(box)), { define: surface.flow }); box.define('reflective-assignment-local-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; Object.assign((alias ||= id(box)), { define: surface.flow }); box.define('reflective-logical-assignment-local-call-receiver', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } box[id(id('define'))] = surface.flow; box.define('nested-same-helper-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { return value.name; } box[key(flag ? { name: 'other' } : { name: 'define' })] = surface.flow; box.define('branched-actual-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { return flag ? value : value; } box[key('define')] = surface.flow; box.define('conditional-return-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { return (flag && value) || value; } box[key('define')] = surface.flow; box.define('logical-return-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; async function key(value: any) { return await value; } async function repair() { box[await key('define')] = surface.flow; box.define('await-return-local-call-key', { budget: '$2' }, () => {}); } repair(); }
        { const box: any = {}; function key(value: any) { let alias; return alias = value; } box[key('define')] = surface.flow; box.define('assignment-return-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { let alias; return alias ||= value; } box[key('define')] = surface.flow; box.define('logical-assignment-return-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } function key(value: any) { return id(value); } box[key('define')] = surface.flow; box.define('nested-call-return-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { return (flag, value); } box[key('define')] = surface.flow; box.define('comma-return-local-call-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any): any { if (flag) return value; return id(value); } Object.assign(id(box), { define: surface.flow }); box.define('recursive-reflective-target', { budget: '$2' }, () => {}); }
        { const box: any = {}; function id(value: any) { return value; } Object.assign(id(id(box)), { define: surface.flow }); box.define('nested-same-helper-reflective-target', { budget: '$2' }, () => {}); }
        { const box: any = {}, other: any = {}; function target(value: any) { return value.slot; } Object.assign(target(flag ? { slot: other } : { slot: box }), { define: surface.flow }); box.define('branched-aggregate-reflective-target', { budget: '$2' }, () => {}); }
        { const box: any = {}, other: any = {}; function target({ holder }: any) { return holder.slot; } Object.assign(target(flag ? { holder: { slot: other } } : { holder: { slot: box } }), { define: surface.flow }); box.define('nested-branched-aggregate-reflective-target', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key(value: any) { return value; } box[key({ name: 'define' }).name] = surface.flow; box.define('returned-container-caller-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key({ skip, ...rest }: any) { return rest; } box[key({ skip: 0, name: 'define' }).name] = surface.flow; box.define('returned-object-rest-caller-key', { budget: '$2' }, () => {}); }
        { const box: any = {}; function key([skip, ...rest]: any[]) { return rest; } box[key([0, 'define'])[0]] = surface.flow; box.define('returned-array-rest-caller-key', { budget: '$2' }, () => {}); }
      `);
      expect(scanTypeScript(formalAndReceiverRepairs).invalidFlowHeaders).toHaveLength(79);
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

    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
