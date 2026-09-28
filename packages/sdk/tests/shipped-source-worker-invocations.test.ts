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
        function objectAssignConditionalTargetWrite(parameter: any) { Object.assign(flag ? parameter : parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignLogicalTargetWrite(parameter: any) { Object.assign((flag && parameter) || parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignNullishTargetWrite(parameter: any) { Object.assign(parameter ?? parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        function objectAssignCommaTargetWrite(parameter: any) { Object.assign((flag, parameter), { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        async function objectAssignAwaitTargetWrite(parameter: any) { Object.assign(await parameter, { agent: f.agent.bind(f, 'real', { task: 'x' }) }); parameter.agent('ignored', { cli: 'claude', model: 'claude-sonnet-5' }); }
        async function wrappedWorkerAliases() { const conditionalRun = flag ? f.agent : f.agent, logicalRun = (flag && f.agent) || f.agent, nullishRun = f.agent ?? f.agent, commaRun = (flag, f.agent), awaitRun = await f.agent; conditionalRun('review', { task: 'x' }); logicalRun('review', { task: 'x' }); nullishRun('review', { task: 'x' }); commaRun('review', { task: 'x' }); awaitRun('review', { task: 'x' }); }
      `);
      const variableAliasResult = scanTypeScript(variableAliases);
      expect(variableAliasResult.calls).toBe(48);
      expect(variableAliasResult.missing).toHaveLength(48);

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
