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
        function boundReflectApplyWorker() { Reflect.apply.bind(Reflect)(f.agent, f, ['review', { task: 'x' }]); }
        function preboundReflectApplyWorker() { const invoke = Reflect.apply.bind(Reflect, f.agent, f); invoke(['review', { task: 'x' }]); }
        function composedCalledReflectApplyWorker() { const invoke = Reflect.apply.call.bind(Reflect.apply); invoke(Reflect, f.agent, f, ['review', { task: 'x' }]); }
        function composedAppliedReflectApplyWorker() { const invoke = Reflect.apply.apply.bind(Reflect.apply); invoke(Reflect, [f.agent, f, ['review', { task: 'x' }]]); }
        function recursiveReflectApplyCallWorker() { Reflect.apply.call.call(Reflect.apply, Reflect, f.agent, f, ['review', { task: 'x' }]); }
        function preboundCalledReflectApplyWorker() { const invoke = Reflect.apply.bind(Reflect, f.agent); invoke.call(null, f, ['review', { task: 'x' }]); }
        function preboundAppliedReflectApplyWorker() { const invoke = Reflect.apply.bind(Reflect, f.agent); invoke.apply(null, [f, ['review', { task: 'x' }]]); }
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
        function reassignedObjectBindingWorker() { let { workers } = { workers: { run: () => undefined } }; ({ workers } = { workers: { run: f.agent } }); workers.run('review', { task: 'x' }); }
        function reassignedArrayBindingWorker() { let [slots] = [[() => undefined]]; [slots] = [[f.agent]]; slots[0]('review', { task: 'x' }); }
        function assignedDestructuredWorker() { let { run } = { run: () => undefined }; run = f.agent; run('review', { task: 'x' }); }
        function computedDestructuredWorker() { const key = 'agent' as const; const { [key]: run } = f; run('review', { task: 'x' }); }
        function recursiveCallHelperWorker() { f.agent.call.call(f.agent, f, 'review', { task: 'x' }); }
        function recursiveApplyHelperWorker() { f.agent.apply.call(f.agent, f, ['review', { task: 'x' }]); }
        async function wrappedWorkerAliases() { const conditionalRun = flag ? f.agent : f.agent, logicalRun = (flag && f.agent) || f.agent, nullishRun = f.agent ?? f.agent, commaRun = (flag, f.agent), awaitRun = await f.agent; conditionalRun('review', { task: 'x' }); logicalRun('review', { task: 'x' }); nullishRun('review', { task: 'x' }); commaRun('review', { task: 'x' }); awaitRun('review', { task: 'x' }); }
      `);
      const variableAliasResult = scanTypeScript(variableAliases);
      expect(variableAliasResult.calls).toBe(174);
      expect(variableAliasResult.missing).toHaveLength(174);

      const assertedAliases = join(directory, 'asserted-aliases.flow.ts');
      writeFileSync(assertedAliases, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        const runAgent = f.agent as typeof f.agent;
        const generate = (f['llm'] satisfies typeof f.llm)!;
        runAgent('review', { task: 'x' });
        generate('prompt', { output: {} });
      `);
      const assertedAliasResult = scanTypeScript(assertedAliases);
      expect(assertedAliasResult.calls).toBe(2);
      expect(assertedAliasResult.missing).toHaveLength(2);

      const boundAliases = join(directory, 'bound-aliases.flow.ts');
      writeFileSync(boundAliases, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        const runAgent = f.agent.bind(f), preboundAgent = f.agent.bind(f, 'real', { task: 'x' }), bindAgent = f.agent.bind, invokeBind = bindAgent.call.bind(bindAgent), reboundAgent = bindAgent.call(preboundAgent, f, 'ignored', { cli: 'claude', model: 'claude-sonnet-5' }), extractedBound = bindAgent.call(f.agent, f, 'real', { task: 'x' }), twiceBound = invokeBind(f.agent, f, 'real', { task: 'x' });
        const generate = f['llm']['bind'](f), preboundLlm = f.llm.bind(f, 'real', { output: {} });
        runAgent('review', { task: 'x' }); preboundAgent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); reboundAgent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); extractedBound('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); twiceBound('ignored', { cli: 'claude', model: 'claude-sonnet-5' });
        generate('prompt', { output: {} }); preboundLlm('ignored', { cli: 'claude', model: 'claude-sonnet-5' });
      `);
      const boundAliasResult = scanTypeScript(boundAliases);
      expect(boundAliasResult.calls).toBe(7);
      expect(boundAliasResult.missing).toHaveLength(7);

      const functionMethods = join(directory, 'function-methods.flow.ts');
      writeFileSync(functionMethods, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        declare const dynamicArgs: ['review', { task: string }], prefix: unknown[];
        f.agent.call(f, 'review', { task: 'x' }); f.agent.call(...prefix, 'ignored', { cli: 'claude', model: 'claude-sonnet-5' });
        f.llm.apply(f, ['prompt', { output: {} }]); f.llm.apply(...prefix, ['ignored', { cli: 'claude', model: 'claude-sonnet-5' }]);
        f.agent.apply(f, dynamicArgs);
      `);
      const functionMethodResult = scanTypeScript(functionMethods);
      expect(functionMethodResult.calls).toBe(5);
      expect(functionMethodResult.missing).toHaveLength(5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
