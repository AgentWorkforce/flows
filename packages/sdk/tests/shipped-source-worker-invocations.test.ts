import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

describe('shipped-source worker invocation resolution', () => {
  it('fails closed across direct, extracted, bound, mutable, and escaped callables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-worker-invocations-'));
    try {
      const elementAccess = join(directory, 'element-access.flow.ts');
      writeFileSync(elementAccess, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        f['agent']('review', { task: 'x' });
        (f['llm'])('prompt', { output: {} });
      `);
      const elementAccessResult = scanTypeScript(elementAccess);
      expect(elementAccessResult.calls).toBe(2);
      expect(elementAccessResult.missing).toHaveLength(2);

      const destructured = join(directory, 'destructured.flow.ts');
      writeFileSync(destructured, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        const { agent } = f;
        const { llm: generate } = f;
        agent('review', { task: 'x' });
        generate('prompt', { output: {} });
      `);
      const destructuredResult = scanTypeScript(destructured);
      expect(destructuredResult.calls).toBe(2);
      expect(destructuredResult.missing).toHaveLength(2);

      const variableAliases = join(directory, 'variable-aliases.flow.ts');
      writeFileSync(variableAliases, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        const runAgent = f.agent;
        declare const flag: boolean;
        const generate = (f['llm']), methods: Array<typeof f.agent | undefined> = [], agentCalls: Array<typeof f.agent.call | undefined> = [], agentApplies: Array<typeof f.agent.apply | undefined> = [], cycles: any[] = []; const [defaultAgent = f.agent] = methods; const [arrayAgent] = [f.agent]; const { method: objectAgent } = { method: f.agent }; const [defaultAgentCall = f.agent.call] = agentCalls; const [defaultAgentApply = f.agent.apply] = agentApplies; const [cyclicAgent = cyclicAgent] = cycles; let mutableAgent = f.agent, mutableCall = f.agent.call, mutableWorker = f, box: any = { worker: f };
        runAgent('review', { task: 'x' }); mutableAgent('review', { task: 'x' }); mutableWorker = { agent: f.agent.bind(f, 'real', { task: 'x' }), llm: f.llm }; mutableWorker.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const { agent: extractedMutable } = mutableWorker; extractedMutable('ignored', { cli: 'claude', model: 'claude-sonnet-5' });
        generate('prompt', { output: {} }); defaultAgent('review', { cli: 'claude', model: 'claude-sonnet-5' }); arrayAgent('review', { cli: 'claude', model: 'claude-sonnet-5' }); objectAgent('review', { cli: 'claude', model: 'claude-sonnet-5' }); defaultAgentCall(f, 'review', { cli: 'claude', model: 'claude-sonnet-5' }); defaultAgentApply(f, ['review', { cli: 'claude', model: 'claude-sonnet-5' }]); cyclicAgent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); mutableCall(f, 'review', { task: 'x' }); box.worker = mutableWorker; box.worker.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); function nested(parameter: any) { parameter.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const alias = parameter; alias.agent = parameter.agent; alias.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const escaped = alias; escaped.agent = parameter.agent; alias.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const objectAlias = { receiver: parameter }; objectAlias.receiver.agent = parameter.agent; parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const { receiver: destructuredAlias } = { receiver: parameter }; destructuredAlias.agent = parameter.agent; parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const assignedBox: any = {}; assignedBox.receiver = parameter; assignedBox.receiver.agent = parameter.agent; parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); parameter.worker = mutableWorker; parameter.worker.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const { worker } = parameter; worker.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); const { agent } = worker; agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function expressionEscape(parameter: any) { const holder: any = {}; holder.receiver = flag ? parameter : parameter; holder.receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function conditionalAliasWrite(parameter: any) { const alias = flag ? parameter : parameter; alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function logicalAliasWrite(parameter: any) { const alias = (flag && parameter) || parameter; alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectDestructuringWrite(parameter: any) { ({ agent: parameter.agent } = { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function arrayDestructuringWrite(parameter: any) { [parameter.agent] = [f.agent.bind(f, 'real', { task: 'x' })]; parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function loopWrite(parameter: any) { for (parameter.agent of [f.agent.bind(f, 'real', { task: 'x' })]) break; parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignWrite(parameter: any) { Object.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignAliasWrite(parameter: any) { const assign = Object.assign; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignBoundWrite(parameter: any) { const assign = Object.assign.bind(Object); assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignCallWrite(parameter: any) { Object.assign.call(Object, parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignApplyWrite(parameter: any) { Object.assign.apply(Object, [parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }]); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignConditionalAliasWrite(parameter: any) { const assign = flag ? Object.assign : Object.assign; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignLogicalAliasWrite(parameter: any) { const assign = (flag && Object.assign) || Object.assign; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignNullishAliasWrite(parameter: any) { const assign = Object.assign ?? Object.assign; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignCommaAliasWrite(parameter: any) { const assign = (flag, Object.assign); assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        async function objectAssignAwaitAliasWrite(parameter: any) { const assign = await Object.assign; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignDestructuredAliasWrite(parameter: any) { const { assign } = Object; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignDestructuredObjectAliasWrite(parameter: any) { const objectAlias = Object; const { assign } = objectAlias; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignDestructuredConditionalWrite(parameter: any) { const { assign } = flag ? Object : Object; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignDestructuredLogicalWrite(parameter: any) { const { assign } = (flag && Object) || Object; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignDestructuredNullishWrite(parameter: any) { const { assign } = Object ?? Object; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignDestructuredCommaWrite(parameter: any) { const { assign } = (flag, Object); assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        async function objectAssignDestructuredAwaitWrite(parameter: any) { const { assign } = await Object; assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignConditionalTargetWrite(parameter: any) { Object.assign(flag ? parameter : parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignLogicalTargetWrite(parameter: any) { Object.assign((flag && parameter) || parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignNullishTargetWrite(parameter: any) { Object.assign(parameter ?? parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignCommaTargetWrite(parameter: any) { Object.assign((flag, parameter), { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        async function objectAssignAwaitTargetWrite(parameter: any) { Object.assign(await parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAliasReceiverAssignWrite(parameter: any) { const O = Object; O.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectDefinePropertyWrite(parameter: any) { Object.defineProperty(parameter, 'agent', { value: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectDefinePropertiesWrite(parameter: any) { Object.defineProperties(parameter, { agent: { value: f.agent.bind(f, 'real', { task: 'x' }) } }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectSetPrototypeOfWrite(parameter: any) { Object.setPrototypeOf(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function reflectSetWrite(parameter: any) { Reflect.set(parameter, 'agent', f.agent.bind(f, 'real', { task: 'x' })); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function reflectDefinePropertyWrite(parameter: any) { Reflect.defineProperty(parameter, 'agent', { value: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function reflectDeletePropertyWrite(parameter: any) { Reflect.deleteProperty(parameter, 'agent'); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function reflectSetPrototypeOfWrite(parameter: any) { Reflect.setPrototypeOf(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function destructuredDefinePropertyWrite(parameter: any) { const { defineProperty } = Object; defineProperty(parameter, 'agent', { value: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function destructuredReflectSetWrite(parameter: any) { const { set } = Reflect; set(parameter, 'agent', f.agent.bind(f, 'real', { task: 'x' })); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function bindingElementObjectAliasWrite(parameter: any) { const [O] = [Object]; O.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function bindingElementObjectDefaultWrite(parameter: any) { const objects: Array<typeof Object | undefined> = []; const [O = Object] = objects; O.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectIntrinsicMemberWrite(parameter: any) { const box = { O: Object }; box.O.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectWriterMemberWrite(parameter: any) { const box = { writer: Object.assign }; box.writer(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function arrayWriterMemberWrite(parameter: any) { const slots = [Object.assign]; slots[0](parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function nestedIntrinsicMemberWrite(parameter: any) { const slots = [{ O: Object }]; slots[0].O.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function nestedWriterMemberWrite(parameter: any) { const slots = [{ writer: Object.assign }]; slots[0].writer(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectWorkerMemberCall() { const box = { run: f.agent }; box.run('review', { task: 'x' }); }
        function arrayWorkerMemberCall() { const slots = [f.agent]; slots[0]('review', { task: 'x' }); }
        function nestedWorkerMemberCall() { const slots = [{ run: f.agent }]; slots[0].run('review', { task: 'x' }); }
        function objectWorkerMemberCallHelper() { const box = { call: f.agent.call }; box.call(f.agent, 'review', { task: 'x' }); }
        function objectWorkerMemberBindHelper() { const box = { bind: f.agent.bind }; box.bind.call(f.agent, undefined, 'review')({ task: 'x' }); }
        function objectWorkerMemberBindInvoker() { const box = { invoker: f.agent.bind.call.bind(f.agent.bind) }; box.invoker(f.agent.bind, f.agent, undefined, 'review')({ task: 'x' }); }
        function reflectSetReceiverWrite(parameter: any) { const target = { agent: f.agent }; Reflect.set(target, 'agent', f.agent.bind(f, 'real', { task: 'x' }), parameter); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function cyclicAggregateMemberCall() { const box: any = { run: box.run }; box.run('review', { task: 'x' }); }
        function computedWorkerMemberCall() { const method = 'agent' as const; f[method]('review', { task: 'x' }); }
        function computedWorkerBindCall() { const method = 'agent' as const, bind = 'bind' as const; f[method][bind](f, 'review')({ task: 'x' }); }
        function computedReflectiveWriter(parameter: any) { const assign = 'assign' as const; Object[assign](parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function computedAggregateWorker() { const key = 'run' as const, box = { [key]: f.agent }; box[key]('review', { task: 'x' }); }
        function objectSpreadWorker() { const box = { ...{ run: f.agent.bind(f) } }; box.run('review', { task: 'x' }); }
        function arraySpreadWorker() { const slots = [...[f.agent.bind(f)]]; slots[0]('review', { task: 'x' }); }
        function objectSpreadWriterWrite(parameter: any) { const box = { ...{ writer: Object.assign } }; box.writer(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function arraySpreadWriterWrite(parameter: any) { const slots = [...[Object.assign]]; slots[0](parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectSpreadIntrinsicWrite(parameter: any) { const box = { ...{ O: Object } }; box.O.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function bindingObjectWorker() { const { box } = { box: { run: f.agent } }; box.run('review', { task: 'x' }); }
        function bindingArrayWorker() { const { slots } = { slots: [f.agent] }; slots[0]('review', { task: 'x' }); }
        function wrappedObjectSpreadWorker() { const box = { ...(flag ? { run: f.agent } : { run: f.agent }) }; box.run('review', { task: 'x' }); }
        function wrappedArraySpreadWorker() { const slots = [...(flag ? [f.agent] : [f.agent])]; slots[0]('review', { task: 'x' }); }
        function bindingObjectWriterWrite(parameter: any) { const { box } = { box: { writer: Object.assign } }; box.writer(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function wrappedArraySpreadWriterWrite(parameter: any) { const slots = [...(flag ? [Object.assign] : [Object.assign])]; slots[0](parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function unknownArraySpreadWorker(extras: unknown[]) { const slots = [f.agent, ...extras]; slots[0]('review', { task: 'x' }); }
        function unknownComputedOverwriteWorker(key: string) { const box = { run: f.agent, [key]: () => undefined }; box.run('review', { task: 'x' }); }
        function objectRestWorker() { const { ...workers } = { run: f.agent }; workers.run('review', { task: 'x' }); }
        function arrayRestWorker() { const [, ...workers] = [undefined, f.agent]; workers[0]('review', { task: 'x' }); }
        function defaultedArrayRestWorker(sources: any[]) { const [, ...workers = [f.agent]] = sources; workers[0]('review', { task: 'x' }); }
        function defaultedArrayRestWriterWrite(parameter: any, sources: any[]) { const [, ...writers = [Object.assign]] = sources; writers[0](parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function nestedArrayRestWorker() { const [, ...[run]] = [undefined, f.agent]; run('review', { task: 'x' }); }
        function nestedArrayRestWriterWrite(parameter: any) { const [, ...[writer]] = [undefined, Object.assign]; writer(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function nestedObjectUnderArrayRestWorker() { const [, ...{ 0: run }] = [undefined, f.agent]; run('review', { task: 'x' }); }
        function nestedObjectUnderArrayRestWriterWrite(parameter: any) { const [, ...{ 0: writer }] = [undefined, Object.assign]; writer(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function defaultedNestedObjectUnderArrayRestWorker(sources: any[]) { const [, ...{ 0: run } = [f.agent]] = sources; run('review', { task: 'x' }); }
        function defaultedNestedObjectUnderArrayRestWriterWrite(parameter: any, sources: any[]) { const [, ...{ 0: writer } = [Object.assign]] = sources; writer(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function outerDefaultArrayRestWorker(source: any) { const { pack: [, ...workers] = [undefined, f.agent] } = source; workers[0]('review', { task: 'x' }); }
        function outerDefaultArrayRestWriterWrite(parameter: any, source: any) { const { pack: [, ...writers] = [undefined, Object.assign] } = source; writers[0](parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectRestWriterWrite(parameter: any) { const { ...writers } = { assign: Object.assign }; writers.assign(parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function numericObjectWorker() { const box = { 0: f.agent }; box[0]('review', { task: 'x' }); }
        function computedNumericObjectWorker() { const box = { [0]: f.agent }; box[0]('review', { task: 'x' }); }
        function stringArrayWorker() { const slots = [f.agent]; slots['0']('review', { task: 'x' }); }
        function computedNumericWriterWrite(parameter: any) { const box = { [0]: Object.assign }; box[0](parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function ordinaryCallEscape(parameter: any) { const overwrite = (receiver: any) => { receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); }; overwrite(parameter); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function ordinaryCallEscapeViaCall(parameter: any) { const overwrite = (receiver: any) => { receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); }; overwrite.call(undefined, parameter); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function ordinaryCallEscapeViaApply(parameter: any) { const overwrite = (receiver: any) => { receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); }; overwrite.apply(undefined, [parameter]); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function ordinaryCallIndirectEscape(parameter: any) { const identity = (receiver: any) => receiver; const overwrite = (receiver: any) => { receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); }; overwrite(identity(parameter)); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function returnedAliasWrite(parameter: any) { const identity = (receiver: any) => receiver; const alias = identity(parameter); alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function directReturnedAliasWrite(parameter: any) { const identity = (receiver: any) => receiver; identity(parameter).agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function restWrapperEscape(parameter: any) { const invoke = (fn: (...args: any[]) => void, ...args: any[]) => fn(...args); const overwrite = (receiver: any) => { receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); }; invoke(overwrite, parameter); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function spreadArgumentEscape(parameter: any) { const overwrite = (receiver: any) => { receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); }; overwrite(...[parameter]); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function returnedConstAliasWrite(parameter: any) { function identity(receiver: any) { const returned = receiver; return returned; } const alias = identity(parameter); alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function returnedAssignedAliasWrite(parameter: any) { function identity(receiver: any) { let returned; returned = receiver; return returned; } const alias = identity(parameter); alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function returnedWrappedAssignedAliasWrite(parameter: any) { function identity(receiver: any) { let returned; (returned as any) = receiver; return returned; } const alias = identity(parameter); alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function returnedLogicalAliasWrite(parameter: any) { function identity(receiver: any) { let returned; returned ??= receiver; return returned; } const alias = identity(parameter); alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function assignedReceiverAliasWrite(parameter: any) { let alias: any; alias = parameter; alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function wrappedAssignedReceiverAliasWrite(parameter: any) { let alias: any; (alias) = parameter; alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function logicalAssignedReceiverAliasWrite(parameter: any) { let alias: any; alias ||= parameter; alias.agent = f.agent.bind(f, 'real', { task: 'x' }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function spreadParameterEscape(parameter: any) { const overwrite = (_unused: any, receiver: any) => { receiver.agent = f.agent.bind(f, 'real', { task: 'x' }); }; overwrite(...[undefined, parameter]); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function reflectApplyWorker() { Reflect.apply(f.agent, f, ['review', { task: 'x' }]); }
        function aliasedReflectApplyWorker() { const apply = Reflect.apply; apply(f.agent, f, ['review', { task: 'x' }]); }
        function aliasedReflectWorker() { const R = Reflect; R.apply(f.agent, f, ['review', { task: 'x' }]); }
        function destructuredReflectApplyWorker() { const { apply } = Reflect; apply(f.agent, f, ['review', { task: 'x' }]); }
        function computedDestructuredReflectApplyWorker() { const key = 'apply' as const; const { [key]: apply } = Reflect; apply(f.agent, f, ['review', { task: 'x' }]); }
        function calledReflectApplyWorker() { Reflect.apply.call(Reflect, f.agent, f, ['review', { task: 'x' }]); }
        function appliedReflectApplyWorker() { Reflect.apply.apply(Reflect, [f.agent, f, ['review', { task: 'x' }]]); }
        function spreadReflectApplyWorker() { Reflect.apply(...[f.agent, f, ['review', { task: 'x' }]] as const); }
        function alternateSpreadReflectApplyWorker() { const noop = () => undefined; Reflect.apply(...(flag ? [noop, null, []] as const : [f.agent, f, ['review', { task: 'x' }]] as const)); }
        function returnedSpreadReflectApplyWorker() { function args() { return [f.agent, f, ['review', { task: 'x' }]] as const; } Reflect.apply(...args()); }
        function alternateSpreadReflectApplyWriterWorker() { const box: any = {}, noop = () => undefined; Reflect.apply(...(flag ? [noop, null, []] as const : [Object.assign, Object, [box, { run: f.agent }]] as const)); box.run('review', { task: 'x' }); }
        function returnedSpreadReflectApplyWriterWorker() { const box: any = {}; function args() { return [Object.assign, Object, [box, { run: f.agent }]] as const; } Reflect.apply(...args()); box.run('review', { task: 'x' }); }
        function boundReflectApplyWorker() { Reflect.apply.bind(Reflect)(f.agent, f, ['review', { task: 'x' }]); }
        function preboundReflectApplyWorker() { const invoke = Reflect.apply.bind(Reflect, f.agent, f); invoke(['review', { task: 'x' }]); }
        function composedCalledReflectApplyWorker() { const invoke = Reflect.apply.call.bind(Reflect.apply); invoke(Reflect, f.agent, f, ['review', { task: 'x' }]); }
        function composedAppliedReflectApplyWorker() { const invoke = Reflect.apply.apply.bind(Reflect.apply); invoke(Reflect, [f.agent, f, ['review', { task: 'x' }]]); }
        function recursiveReflectApplyCallWorker() { Reflect.apply.call.call(Reflect.apply, Reflect, f.agent, f, ['review', { task: 'x' }]); }
        function nestedReflectApplyWorker() { Reflect.apply(Reflect.apply, Reflect, [f.agent, f, ['review', { task: 'x' }]]); }
        function preboundCalledReflectApplyWorker() { const invoke = Reflect.apply.bind(Reflect, f.agent); invoke.call(null, f, ['review', { task: 'x' }]); }
        function preboundAppliedReflectApplyWorker() { const invoke = Reflect.apply.bind(Reflect, f.agent); invoke.apply(null, [f, ['review', { task: 'x' }]]); }
        function overwrittenAggregateReflectApplyWorker() { let helper: any; helper = { invoke: Reflect.apply }; helper.invoke(f.agent, f, ['review', { task: 'x' }]); helper = { invoke: () => undefined }; }
        function overwrittenComposedReflectApplyWorker() { let helper: any; helper = { invoke: Reflect.apply.call.bind(Reflect.apply) }; helper.invoke(Reflect, f.agent, f, ['review', { task: 'x' }]); helper = { invoke: Reflect.apply }; }
        function globalThisReflectApplyWorker() { globalThis.Reflect.apply(f.agent, f, ['review', { task: 'x' }]); }
        function assignedDestructuredReflectApplyWorker() { let apply: any; ({ apply } = Reflect); apply(f.agent, f, ['review', { task: 'x' }]); }
        function assignedComputedReflectApplyWorker() { const key = 'apply' as const; let apply: any; ({ [key]: apply } = Reflect); apply(f.agent, f, ['review', { task: 'x' }]); }
        function forwardedWorker() { const invoke = (run: (...args: any[]) => void, ...args: any[]) => run(...args); invoke(f.agent, 'review', { task: 'x' }); }
        function spreadForwardedWorker() { const invoke = (run: (...args: any[]) => void, ...args: any[]) => run(...args); invoke(...[f.agent, 'review', { task: 'x' }] as const); }
        function assignedWorker() { let run: any = () => undefined; run = f.agent; run('review', { task: 'x' }); }
        function wrappedAssignedWorker() { let run: any = () => undefined; (run as any) = f.agent; run('review', { task: 'x' }); }
        function orAssignedWorker() { let run: any; run ||= f.agent; run('review', { task: 'x' }); }
        function andAssignedWorker() { let run: any = () => undefined; run &&= f.agent; run('review', { task: 'x' }); }
        function nullishAssignedWorker() { let run: any; run ??= f.agent; run('review', { task: 'x' }); }
        function objectAssignedWorker() { let run: any; ({ run } = { run: f.agent }); run('review', { task: 'x' }); }
        function arrayAssignedWorker() { let run: any; [run] = [f.agent]; run('review', { task: 'x' }); }
        function defaultedObjectAssignedWorker() { let run: any; ({ run = f.agent } = {}); run('review', { task: 'x' }); }
        function defaultedArrayAssignedWorker() { let run: any; [run = f.agent] = []; run('review', { task: 'x' }); }
        function arrayRestAssignedWorker() { let workers: any; [, ...workers] = [undefined, f.agent]; workers[0]('review', { task: 'x' }); }
        function nestedArrayRestAssignedWorker() { let run: any; [, ...[run]] = [undefined, f.agent]; run('review', { task: 'x' }); }
        function doublyNestedArrayRestAssignedWorker() { let workers: any; [, ...[, ...workers]] = [undefined, undefined, f.agent]; workers[0]('review', { task: 'x' }); }
        function objectRestAssignedWorker() { let workers: any; ({ ...workers } = { run: f.agent }); workers.run('review', { task: 'x' }); }
        function laterObjectAssignedWorker() { let worker: any; worker = { run: () => undefined }; worker = { run: f.agent }; worker.run('review', { task: 'x' }); }
        function laterArrayRestAssignedWorker() { let workers: any; [...workers] = [() => undefined]; [...workers] = [f.agent]; workers[0]('review', { task: 'x' }); }
        function laterSafeObjectAssignedWorker() { let worker: any; worker = { run: f.agent }; worker.run('review', { task: 'x' }); worker = { run: () => undefined }; }
        function laterSafeArrayRestAssignedWorker() { let workers: any; [...workers] = [f.agent]; workers[0]('review', { task: 'x' }); [...workers] = [() => undefined]; }
        function branchedObjectAssignedWorker(flag: boolean) { let worker: any; if (flag) worker = { run: f.agent }; else worker = { run: () => undefined }; worker.run('review', { task: 'x' }); }
        function memberAssignedWorker() { const box: any = {}; box.run = f.agent; box.run('review', { task: 'x' }); }
        function nestedMemberAssignedWorker() { const box: any = {}; box.worker = { run: f.agent }; box.worker.run('review', { task: 'x' }); }
        function elementAssignedWorker() { const slots: any[] = []; slots[0] = f.agent; slots[0]('review', { task: 'x' }); }
        function objectPatternMemberAssignedWorker() { const box: any = {}; ({ run: box.run } = { run: f.agent }); box.run('review', { task: 'x' }); }
        function arrayPatternMemberAssignedWorker() { const slots: any[] = []; [slots[0]] = [f.agent]; slots[0]('review', { task: 'x' }); }
        function objectAssignMemberWorker() { const box: any = {}; Object.assign(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function reflectSetMemberWorker() { const box: any = {}; Reflect.set(box, 'run', f.agent); box.run('review', { task: 'x' }); }
        function objectAssignCallMemberWorker() { const box: any = {}; Object.assign.call(Object, box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function objectAssignApplyMemberWorker() { const box: any = {}; Object.assign.apply(Object, [box, { run: f.agent }]); box.run('review', { task: 'x' }); }
        function objectAssignBindMemberWorker() { const box: any = {}; Object.assign.bind(Object)(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function reflectSetCallMemberWorker() { const box: any = {}; Reflect.set.call(Reflect, box, 'run', f.agent); box.run('review', { task: 'x' }); }
        function reflectSetApplyMemberWorker() { const box: any = {}; Reflect.set.apply(Reflect, [box, 'run', f.agent]); box.run('review', { task: 'x' }); }
        function reflectSetBindMemberWorker() { const box: any = {}; Reflect.set.bind(Reflect)(box, 'run', f.agent); box.run('review', { task: 'x' }); }
        function reflectApplyObjectAssignMemberWorker() { const box: any = {}; Reflect.apply(Object.assign, Object, [box, { run: f.agent }]); box.run('review', { task: 'x' }); }
        function reflectApplyReflectSetMemberWorker() { const box: any = {}; Reflect.apply(Reflect.set, Reflect, [box, 'run', f.agent]); box.run('review', { task: 'x' }); }
        function aggregateObjectAssignMemberWorker() { const box: any = {}, helpers = { assign: Object.assign }; helpers.assign(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function memberAssignedObjectAssignMemberWorker() { const box: any = {}, helpers: any = {}; helpers.assign = Object.assign; helpers.assign(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function defaultedObjectAssignMemberWorker() { const box: any = {}, assigners: Array<typeof Object.assign | undefined> = []; const [assign = Object.assign] = assigners; assign(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function assignedDestructuredObjectAssignMemberWorker() { const box: any = {}; let assign: any; ({ assign } = Object); assign(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function boundObjectAssignAliasMemberWorker() { const box: any = {}, assign = Object.assign.bind(Object); assign(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function aliasedDefinePropertiesMemberWorker() { const box: any = {}, descriptors = { run: { value: f.agent } }; Object.defineProperties(box, descriptors); box.run('review', { task: 'x' }); }
        function memberAssignedDefinePropertiesMemberWorker() { const box: any = {}, maps: any = {}; maps.descriptors = { run: { value: f.agent } }; Object.defineProperties(box, maps.descriptors); box.run('review', { task: 'x' }); }
        function spreadDefinePropertiesMemberWorker() { const box: any = {}, descriptors = { ...{ run: { value: f.agent } } }; Object.defineProperties(box, descriptors); box.run('review', { task: 'x' }); }
        function aliasedReflectiveTargetMemberWorker() { const box: any = {}, alias = box; Object.assign(alias, { run: f.agent }); box.run('review', { task: 'x' }); }
        function returnedReflectiveTargetMemberWorker() { const box: any = {}; const identity = (value: any) => value; Object.assign(identity(box), { run: f.agent }); box.run('review', { task: 'x' }); }
        function returnedConstAliasReflectiveTargetMemberWorker() { const box: any = {}; function identity(value: any) { const alias = value; return alias; } Object.assign(identity(box), { run: f.agent }); box.run('review', { task: 'x' }); }
        function returnedAssignedAliasReflectiveTargetMemberWorker() { const box: any = {}; function identity(value: any) { let alias; alias = value; return alias; } Object.assign(identity(box), { run: f.agent }); box.run('review', { task: 'x' }); }
        function returnedWrappedReflectiveTargetMemberWorker() { const box: any = {}; function identity(value: any) { return flag ? value : value; } Object.assign(identity(box), { run: f.agent }); box.run('review', { task: 'x' }); }
        function capturedReflectiveTargetMemberWorker() { const box: any = {}; function getBox() { return box; } Object.assign(getBox(), { run: f.agent }); box.run('review', { task: 'x' }); }
        function branchedApplyReflectiveWriterMemberWorker() { const box: any = {}; Object.assign.apply(Object, flag ? [box, { run: () => undefined }] : [box, { run: f.agent }]); box.run('review', { task: 'x' }); }
        function spreadReflectiveWriterMemberWorker(extras: any[]) { const box: any = {}; Object.assign(box, { run: f.agent }, ...extras); box.run('review', { task: 'x' }); }
        function spreadApplyReflectiveWriterMemberWorker(extras: any[]) { const box: any = {}; Object.assign.apply(Object, [box, ...extras, { run: f.agent }]); box.run('review', { task: 'x' }); }
        function spreadReflectApplyReflectiveWriterMemberWorker(extras: any[]) { const box: any = {}; Reflect.apply(Object.assign, Object, [box, ...extras, { run: f.agent }]); box.run('review', { task: 'x' }); }
        function objectGetterMemberWorker() { const box: any = { get run() { return f.agent; } }; box.run('review', { task: 'x' }); }
        function pairedAccessorMemberWorker() { const box: any = { get run() { return f.agent; }, set run(value: any) {} }; box.run('review', { task: 'x' }); }
        function branchedObjectGetterMemberWorker() { const box: any = { get run() { if (flag) return () => undefined; return f.agent; } }; box.run('review', { task: 'x' }); }
        function definePropertyGetterMemberWorker() { const box: any = {}; Object.defineProperty(box, 'run', { get() { return f.agent; } }); box.run('review', { task: 'x' }); }
        function aliasedDefinePropertyGetterMemberWorker() { const box: any = {}, getter = () => f.agent; Object.defineProperty(box, 'run', { get: getter }); box.run('review', { task: 'x' }); }
        function definePropertiesGetterMemberWorker() { const box: any = {}; Object.defineProperties(box, { run: { get() { return f.agent; } } }); box.run('review', { task: 'x' }); }
        function nestedRestMemberAssignedWorker() { const box: any = {}; [...[box.slots]] = [[f.agent]]; box.slots[0]('review', { task: 'x' }); }
        function arrayRestMemberAssignedWorker() { const box: any = {}; [...box.slots] = [f.agent]; box.slots[0]('review', { task: 'x' }); }
        function objectRestMemberAssignedWorker() { const box: any = {}; ({ ...box.workers } = { run: f.agent }); box.workers.run('review', { task: 'x' }); }
        function objectDefinePropertyMemberWorker() { const box: any = {}; Object.defineProperty(box, 'run', { value: f.agent }); box.run('review', { task: 'x' }); }
        function objectDefinePropertiesMemberWorker() { const box: any = {}; Object.defineProperties(box, { run: { value: f.agent } }); box.run('review', { task: 'x' }); }
        function objectSetPrototypeMemberWorker() { const box: any = {}; Object.setPrototypeOf(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function reflectDefinePropertyMemberWorker() { const box: any = {}; Reflect.defineProperty(box, 'run', { value: f.agent }); box.run('review', { task: 'x' }); }
        function reflectSetPrototypeMemberWorker() { const box: any = {}; Reflect.setPrototypeOf(box, { run: f.agent }); box.run('review', { task: 'x' }); }
        function reassignedObjectBindingWorker() { let { workers } = { workers: { run: () => undefined } }; ({ workers } = { workers: { run: f.agent } }); workers.run('review', { task: 'x' }); }
        function reassignedArrayBindingWorker() { let [slots] = [[() => undefined]]; [slots] = [[f.agent]]; slots[0]('review', { task: 'x' }); }
        function assignedDestructuredWorker() { let { run } = { run: () => undefined }; run = f.agent; run('review', { task: 'x' }); }
        function computedDestructuredWorker() { const key = 'agent' as const; const { [key]: run } = f; run('review', { task: 'x' }); }
        function renamedComputedDestructuredWorker() { const original = 'agent' as const, key = original; const { [key]: run } = f; run('review', { task: 'x' }); }
        function bindingComputedDestructuredWorker() { const { key } = { key: 'agent' as const }; const { [key]: run } = f; run('review', { task: 'x' }); }
        function logicalComputedDestructuredWorker() { const key = (flag && 'agent') || 'agent'; const { [key]: run } = f; run('review', { task: 'x' }); }
        function nestedComputedDestructuredWorker() { const key = 'agent' as const; const { [key]: { [key]: run } } = { agent: { agent: f.agent } }; run('review', { task: 'x' }); }
        function recursiveCallHelperWorker() { f.agent.call.call(f.agent, f, 'review', { task: 'x' }); }
        function recursiveApplyHelperWorker() { f.agent.apply.call(f.agent, f, ['review', { task: 'x' }]); }
        async function wrappedWorkerAliases() { const conditionalRun = flag ? f.agent : f.agent, logicalRun = (flag && f.agent) || f.agent, nullishRun = f.agent ?? f.agent, commaRun = (flag, f.agent), awaitRun = await f.agent; conditionalRun('review', { task: 'x' }); logicalRun('review', { task: 'x' }); nullishRun('review', { task: 'x' }); commaRun('review', { task: 'x' }); awaitRun('review', { task: 'x' }); }
      `);
      const variableAliasResult = scanTypeScript(variableAliases);
      expect(variableAliasResult.calls).toBe(230);
      expect(variableAliasResult.missing).toHaveLength(230);
      const repairedWorkerCases = [
        `const box: any = {}, helpers: any = {}; helpers.assign = Object.assign; helpers.assign(box, { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}, maps: any = {}; maps.descriptors = { run: { value: f.agent } }; Object.defineProperties(box, maps.descriptors); box.run('review', { task: 'x' });`,
        `const box: any = {}; function identity(value: any) { const alias = value; return alias; } Object.assign(identity(box), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function identity(value: any) { let alias; alias = value; return alias; } Object.assign(identity(box), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function identity(value: any) { return flag ? value : value; } Object.assign(identity(box), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function getBox() { return box; } Object.assign(getBox(), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}, getter = () => f.agent; Object.defineProperty(box, 'run', { get: getter }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function id(...values: any[]) { return values[0]; } Object.assign(id(box), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function id({ value }: { value: any }) { return value; } Object.assign(id({ value: box }), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function id(value: any) { return value; } Object.assign(id(...[box]), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function id(value: any = box) { return value; } Object.assign(id(), { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}, alias = box; alias.run = f.agent; box.run('review', { task: 'x' });`,
        `let key: string; key = 'agent'; const { [key]: run } = f; run('review', { task: 'x' });`,
        `const source = flag ? { key: 'agent' as const } : { key: 'agent' as const }; const { key } = source; const { [key]: run } = f; run('review', { task: 'x' });`,
        `const source = (flag && { key: 'agent' as const }) || { key: 'agent' as const }; const { key } = source; const { [key]: run } = f; run('review', { task: 'x' });`,
        `const box: any = {}, captured = { keys: { value: 'run' as const } }; function get() { return captured; } box[get().keys.value] = f.agent; box.run('review', { task: 'x' });`,
        `const box: any = {}; function key(value: any) { return value; } let alias: any; box[(alias = key({ name: 'run' })).name] = f.agent; box.run('review', { task: 'x' });`,
        `const box: any = {}; function key(value: any) { return value; } let alias: any; box[(alias ||= key({ name: 'run' })).name] = f.agent; box.run('review', { task: 'x' });`,
        `const box: any = {}; const source = flag ? { key: 'other' as const } : { key: 'run' as const }; const { key } = source; box[key] = f.agent; box.run('review', { task: 'x' });`,
        `const source = flag ? { worker: () => undefined } : { worker: f.agent }; const { worker } = source; worker('review', { task: 'x' });`,
        `const source = flag ? { nested: { worker: () => undefined } } : { nested: { worker: f.agent } }; const { nested: { worker } } = source; worker('review', { task: 'x' });`,
        `const box: any = {}, a: any = {}, b: any = {}; a.descriptors = b.descriptors; b.descriptors = a.descriptors; b.descriptors = { run: { value: f.agent } }; Object.defineProperties(box, a.descriptors); box.run('review', { task: 'x' });`,
        `const box: any = {}, a: any = {}, b: any = {}; a.getter = b.getter; b.getter = a.getter; b.getter = () => f.agent; Object.defineProperty(box, 'run', { get: a.getter }); box.run('review', { task: 'x' });`,
        `const key = 'workers' as const, holder = { workers: [f.agent] }; for (const run of holder[key]) run('review', { task: 'x' });`,
        `const holder: any = {}; Object.assign(holder, { workers: [f.agent] }); for (const run of holder.workers) run('review', { task: 'x' });`,
        `function getHolder() { return { workers: [f.agent] }; } for (const run of getHolder().workers) run('review', { task: 'x' });`,
        `const workers: any[] = []; workers[0] = f.agent; for (const run of workers) run('review', { task: 'x' });`,
        `const workers: any[] = [], alias = workers; alias.push(f.agent); for (const run of workers) run('review', { task: 'x' });`,
        `let rest: any[]; [, ...rest] = flag ? [0, () => undefined] : [0, f.agent]; rest[0]('review', { task: 'x' });`,
        `declare const unknown: any; const { o: obj = { k: 'agent' as const } } = unknown; const { [obj.k]: run } = f; run('review', { task: 'x' });`,
        `const holder: any = flag ? { workers: holder.workers } : { workers: [f.agent] }; for (const run of holder.workers) run('review', { task: 'x' });`,
        `declare const runtimeKey: string; const holder = { workers: [f.agent], other: [() => undefined] }; for (const run of holder[runtimeKey]) run('review', { task: 'x' });`,
        `const box: any = {}, holder: any = {}; Object.assign(holder, { ops: [Object.assign] }); for (const op of holder.ops) op(box, { run: f.agent }); box.run('review', { task: 'x' });`,
        `const box: any = {}; function getHolder() { return { ops: [Object.assign] }; } for (const op of getHolder().ops) op(box, { run: f.agent }); box.run('review', { task: 'x' });`,
        `const holder: any = {}, alias = holder; Object.assign(alias, { workers: [f.agent] }); for (const run of holder.workers) run('review', { task: 'x' });`,
        `const box: any = {}, holder: any = {}, alias = holder; Object.assign(alias, { ops: [Object.assign] }); for (const op of holder.ops) op(box, { run: f.agent }); box.run('review', { task: 'x' });`,
        `function inner() { return [f.agent]; } function getHolder() { return { workers: inner() }; } for (const run of getHolder().workers) run('review', { task: 'x' });`,
        `const box: any = {}; function inner() { return [Object.assign]; } function getHolder() { return { ops: inner() }; } for (const op of getHolder().ops) op(box, { run: f.agent }); box.run('review', { task: 'x' });`,
        `function worker({ o = { k: 'agent' as const } }: any) { const { [o.k]: run } = f; run('review', { task: 'x' }); } worker({ o: { k: 'llm' } });`,
        `const [, workers] = [, [f.agent]]; for (const run of workers) run('review', { task: 'x' });`,
        `const [workers] = flag ? [[() => undefined]] : [[f.agent]]; for (const run of workers) run('review', { task: 'x' });`,
        `function first(): any[] { return second(); } function second(): any[] { return flag ? first() : [f.agent]; } for (const run of first()) run('review', { task: 'x' });`,
        `declare const unknownItems: any[]; for (const run of [...unknownItems, f.agent]) run('review', { task: 'x' });`,
        `declare const unknownItems: any[]; const box: any = {}; for (const op of [...unknownItems, Object.assign]) op(box, { run: f.agent }); box.run('review', { task: 'x' });`,
        `function pass(args: any) { return args; } Reflect.apply(...pass([f.agent, f, ['review', { task: 'x' }]]));`,
        `const box: any = {}; function pass(args: any) { return args; } Reflect.apply(...pass([Object.assign, Object, [box, { run: f.agent }]])); box.run('review', { task: 'x' });`,
      ];
      for (const [index, candidate] of repairedWorkerCases.entries()) {
        const repairedWorker = join(directory, `repaired-worker-${index}.flow.ts`);
        writeFileSync(repairedWorker, `declare const f: any, flag: boolean; ${candidate}`);
        const result = scanTypeScript(repairedWorker);
        expect(result.calls, candidate).toBe(1);
        expect(result.missing, candidate).toHaveLength(1);
      }

      const dynamicMutableReceivers = join(directory, 'dynamic-mutable-receivers.flow.ts');
      writeFileSync(dynamicMutableReceivers, `
        declare const key: string;
        declare const f: {
          agent(name: string, options: object): void;
          llm(...args: unknown[]): void;
          [key: string]: (...args: any[]) => void;
        };
        let worker = f;
        worker = f;
        worker[key]('review', { cli: 'claude', model: 'claude-sonnet-5' });
        const { [key]: run } = worker;
        run('review', { cli: 'claude', model: 'claude-sonnet-5' });
      `);
      const dynamicMutableResult = scanTypeScript(dynamicMutableReceivers);
      expect(dynamicMutableResult.calls).toBe(2);
      expect(dynamicMutableResult.missing).toHaveLength(2);

      const formalAndReceiverRepairs = join(directory, 'formal-and-receiver-repairs.flow.ts');
      writeFileSync(formalAndReceiverRepairs, `
        declare const f: any, flag: boolean;
        { const box: any = {}; function id(value: any = box) { return value; } Object.assign(id(undefined), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = { nested: {} }; function id(...values: any[]) { return values['0'].nested; } Object.assign(id(box), { run: f.agent }); box.nested.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest[0]; } Object.assign(id([undefined, box]), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}, other: any = {}; function id(value: any) { return value; } Object.assign(id(...(flag ? [other] : [box])), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; let alias: any; alias = box; alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, alias = flag ? box : box; alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, holder = { alias: box }; holder.alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, holder = [box]; holder[0].run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; const { alias } = { alias: box }; alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; let alias: any; ({ alias } = { alias: box }); alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, holder = { alias: box }; Object.assign(holder.alias, { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; let key: string; key = 'run'; box[key] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, other: any = {}; let alias: any = other; alias = box; alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; let alias: any = null; alias ||= box; alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; let holder: any = {}; holder = { alias: box }; holder.alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, holder: any = {}; holder.alias = box; holder.alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const holder: any = { alias: {} }; const { alias } = holder; alias.run = f.agent; holder.alias.run('review', { task: 'x' }); }
        { const box: any = {}; function id(...[{ value }]: any[]) { return value; } Object.assign(id({ value: box }), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = { nested: {} }; function id(...[{ value }]: any[]) { return value.nested; } Object.assign(id({ value: box }), { run: f.agent }); box.nested.run('review', { task: 'x' }); }
        { const box: any = {}; function id(...[[value]]: any[]) { return value; } Object.assign(id([box]), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(...[skip, value]: any[]) { return value; } Object.assign(id(undefined, box), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...[unused, ...rest]]: any[]) { return rest[0]; } Object.assign(id([undefined, undefined, box]), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; let key: string; key = 'run'; box[key] = f.agent; key = 'other'; box.run('review', { task: 'x' }); }
        { const box: any = {}; let key: string; ({ key } = { key: 'run' }); box[key] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; let key: string; [key] = ['run']; box[key] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; let key: string; if (flag) key = 'run'; else key = 'other'; box[key] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } const alias = id(box); alias.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, keys: any = {}; keys.value = 'run'; box[keys.value] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(...[skip, ...[value]]: any[]) { return value; } Object.assign(id(undefined, box), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(...[[skip, ...rest]]: any[]) { return rest[0]; } Object.assign(id([undefined, box]), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(...[{ items: [skip, ...rest] }]: any[]) { return rest[0]; } Object.assign(id({ items: [undefined, box] }), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(...[[skip, ...[value]]]: any[]) { return value; } Object.assign(id([undefined, box]), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}, keys: any = {}; keys.a = 'run'; keys.a = keys.b; keys.b = keys.a; box[keys.a] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } (flag ? id(box) : id(box)).run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } ((flag && id(box)) || id(box)).run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } async function repair() { (await id(box)).run = f.agent; box.run('review', { task: 'x' }); } repair(); }
        { const box: any = {}, holder = { keys: { value: 'run' as const } }; box[holder.keys.value] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, keys: any = {}; keys.b = 'run'; keys.a = keys.b; box[keys.a] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } Object.assign(id([undefined, box])[0], { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; (alias = id(box)).run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; (alias ||= id(box)).run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key() { return 'run' as const; } box[key()] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id({ skip, ...rest }: any) { return rest; } Object.assign(id({ skip: 0, value: box }).value, { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}, holder = { keys: flag ? { value: 'other' as const } : { value: 'run' as const } }; box[holder.keys.value] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, holder = { keys: { value: 'run' as const } }; function get() { return holder; } box[get().keys.value] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}, first = { keys: { value: 'other' as const } }, second = { keys: { value: 'run' as const } }; box[(flag ? first : second).keys.value] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } const chosen = id([undefined, box]); chosen[0].run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } const chosen = id([undefined, box]); Object.assign(chosen[0], { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id({ skip, ...rest }: any) { return rest; } const chosen = id({ skip: 0, value: box }); chosen.value.run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id({ skip, ...rest }: any) { return rest; } const chosen = id({ skip: 0, value: box }); Object.assign(chosen.value, { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } (flag ? id([undefined, box]) : id([undefined, box]))[0].run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } Object.assign((flag ? id([undefined, box]) : id([undefined, box]))[0], { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } ((flag && id([undefined, box])) || id([undefined, box]))[0].run = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id([skip, ...rest]: any[]) { return rest; } async function repair() { (await id([undefined, box]))[0].run = f.agent; box.run('review', { task: 'x' }); } repair(); }
        { const box: any = {}, keys: any = {}; keys.a = { b: 'run' }; keys['a/string:b'] = keys.a.b; box[keys['a/string:b']] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { return value; } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { return value.name; } box[key({ name: 'run' })] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any = 'run') { return value; } box[key(undefined)] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(...values: any[]) { return values[0]; } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key({ name }: any) { return name; } box[key({ name: 'run' })] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key([skip, ...rest]: any[]) { return rest[0]; } box[key([undefined, 'run'])] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; Object.assign((alias = id(box)), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } let alias: any; Object.assign((alias ||= id(box)), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } box[id(id('run'))] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { return value.name; } box[key(flag ? { name: 'other' } : { name: 'run' })] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { return flag ? value : value; } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { return (flag && value) || value; } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; async function key(value: any) { return await value; } async function repair() { box[await key('run')] = f.agent; box.run('review', { task: 'x' }); } repair(); }
        { const box: any = {}; function key(value: any) { let alias; return alias = value; } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { let alias; return alias ||= value; } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } function key(value: any) { return id(value); } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { return (flag, value); } box[key('run')] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any): any { if (flag) return value; return id(value); } Object.assign(id(box), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } Object.assign(id(id(box)), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}, other: any = {}; function target(value: any) { return value.slot; } Object.assign(target(flag ? { slot: other } : { slot: box }), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}, other: any = {}; function target({ holder }: any) { return holder.slot; } Object.assign(target(flag ? { holder: { slot: other } } : { holder: { slot: box } }), { run: f.agent }); box.run('review', { task: 'x' }); }
        { const box: any = {}; function key(value: any) { return value; } box[key({ name: 'run' }).name] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key({ skip, ...rest }: any) { return rest; } box[key({ skip: 0, name: 'run' }).name] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function key([skip, ...rest]: any[]) { return rest; } box[key([0, 'run'])[0]] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; function id(value: any) { return value; } box[id(id({ name: 'run' })).name] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; const source = flag ? { key: 'other' as const } : { key: runtimeKey }; declare const runtimeKey: string; const { key } = source; box[key] = f.agent; box.run('review', { task: 'x' }); }
        { const box: any = {}; const captured = flag ? { keys: { value: 'other' as const } } : { keys: { value: 'run' as const } }; function get() { return captured.keys; } box[get().value] = f.agent; box.run('review', { task: 'x' }); }
      `);
      const formalAndReceiverResult = scanTypeScript(formalAndReceiverRepairs);
      expect(formalAndReceiverResult.calls).toBe(82);
      expect(formalAndReceiverResult.missing).toHaveLength(82);

      const recursiveLocalCallKey = join(directory, 'recursive-local-call-key.flow.ts');
      writeFileSync(recursiveLocalCallKey, `
        declare const f: { agent(name: string, options: { task: string }): void };
        const box: any = {};
        function key(value: any): any { return key(value); }
        box[key('run')] = f.agent;
        box.run('review', { task: 'x' });
      `);
      const recursiveLocalCallKeyResult = scanTypeScript(recursiveLocalCallKey);
      expect(recursiveLocalCallKeyResult.calls).toBe(1);
      expect(recursiveLocalCallKeyResult.missing).toHaveLength(1);

    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
