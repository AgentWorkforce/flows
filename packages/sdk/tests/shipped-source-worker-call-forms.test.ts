import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

describe('shipped-source worker call forms', () => {
  it('fails closed for computed keys, assertions, binds, call, and apply', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-worker-call-forms-'));
    try {
      const unresolvedComputedBinding = join(directory, 'unresolved-computed-binding.flow.ts');
      writeFileSync(unresolvedComputedBinding, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        declare const flag: boolean, other: string;
        const { [flag ? 'agent' : other]: run } = f;
        run('review', { task: 'x' });
      `);
      const unresolvedComputedBindingResult = scanTypeScript(unresolvedComputedBinding);
      expect(unresolvedComputedBindingResult.calls).toBe(1);
      expect(unresolvedComputedBindingResult.missing).toHaveLength(1);

      const unresolvedAssignedKey = join(directory, 'unresolved-assigned-key.flow.ts');
      writeFileSync(unresolvedAssignedKey, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean, other: string;
        let key: string;
        key = 'agent';
        if (flag) key = other;
        f[key]('review', { task: 'x' });
      `);
      const unresolvedAssignedKeyResult = scanTypeScript(unresolvedAssignedKey);
      expect(unresolvedAssignedKeyResult.calls).toBe(1);
      expect(unresolvedAssignedKeyResult.missing).toHaveLength(1);

      const mutableInitializerKey = join(directory, 'mutable-initializer-key.flow.ts');
      writeFileSync(mutableInitializerKey, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        declare const flag: boolean;
        let key = 'llm';
        if (flag) key = 'agent';
        f[key]('review', { task: 'x' });
      `);
      const mutableInitializerKeyResult = scanTypeScript(mutableInitializerKey);
      expect(mutableInitializerKeyResult.calls).toBe(1);
      expect(mutableInitializerKeyResult.missing).toHaveLength(1);

      const mutableDestructuredInitializerKey = join(directory, 'mutable-destructured-initializer-key.flow.ts');
      writeFileSync(mutableDestructuredInitializerKey, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        declare const flag: boolean;
        let { key } = { key: 'llm' };
        if (flag) key = 'agent';
        f[key]('review', { task: 'x' });
      `);
      const mutableDestructuredResult = scanTypeScript(mutableDestructuredInitializerKey);
      expect(mutableDestructuredResult.calls).toBe(1);
      expect(mutableDestructuredResult.missing).toHaveLength(1);

      const unresolvedDestructuredInitializerKey = join(directory, 'unresolved-destructured-initializer-key.flow.ts');
      writeFileSync(unresolvedDestructuredInitializerKey, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const runtimeKey: string;
        let { key } = { key: runtimeKey };
        key = 'agent';
        f[key]('review', { task: 'x' });
      `);
      const unresolvedDestructuredResult = scanTypeScript(unresolvedDestructuredInitializerKey);
      expect(unresolvedDestructuredResult.calls).toBe(1);
      expect(unresolvedDestructuredResult.missing).toHaveLength(1);

      const unresolvedComputedDefault = join(directory, 'unresolved-computed-default.flow.ts');
      writeFileSync(unresolvedComputedDefault, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        declare const runtimeKey: string;
        const { [runtimeKey]: call = f.agent } = f;
        call('review', { task: 'x' });
      `);
      const unresolvedComputedDefaultResult = scanTypeScript(unresolvedComputedDefault);
      expect(unresolvedComputedDefaultResult.calls).toBe(1);
      expect(unresolvedComputedDefaultResult.missing).toHaveLength(1);

      const loopCarriedKey = join(directory, 'loop-carried-key.flow.ts');
      writeFileSync(loopCarriedKey, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        declare const items: unknown[];
        let key = 'agent';
        for (const item of items) {
          f[key]('review', { task: 'x' });
          key = 'llm';
        }
      `);
      const loopCarriedResult = scanTypeScript(loopCarriedKey);
      expect(loopCarriedResult.calls).toBe(1);
      expect(loopCarriedResult.missing).toHaveLength(1);

      const repeatedFunctionKey = join(directory, 'repeated-function-key.flow.ts');
      writeFileSync(repeatedFunctionKey, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        let key = 'agent';
        function invoke() {
          f[key]('review', { task: 'x' });
          key = 'llm';
        }
        invoke();
        invoke();
      `);
      const repeatedFunctionResult = scanTypeScript(repeatedFunctionKey);
      expect(repeatedFunctionResult.calls).toBe(1);
      expect(repeatedFunctionResult.missing).toHaveLength(1);

      const chainedDestructuredCallable = join(directory, 'chained-destructured-callable.flow.ts');
      writeFileSync(chainedDestructuredCallable, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean;
        const source = flag
          ? { outer: { worker: () => undefined } }
          : { outer: { worker: f.agent } };
        const { outer } = source;
        const { worker } = outer;
        worker('review', { task: 'x' });
      `);
      const chainedDestructuredResult = scanTypeScript(chainedDestructuredCallable);
      expect(chainedDestructuredResult.calls).toBe(1);
      expect(chainedDestructuredResult.missing).toHaveLength(1);

      const arrayAlternativeCallable = join(directory, 'array-alternative-callable.flow.ts');
      writeFileSync(arrayAlternativeCallable, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean;
        const [outer] = flag
          ? [{ worker: () => undefined }]
          : [{ worker: f.agent }];
        const { worker } = outer;
        worker('review', { task: 'x' });
      `);
      const arrayAlternativeResult = scanTypeScript(arrayAlternativeCallable);
      expect(arrayAlternativeResult.calls).toBe(1);
      expect(arrayAlternativeResult.missing).toHaveLength(1);

      const mutableChainedCallable = join(directory, 'mutable-chained-callable.flow.ts');
      writeFileSync(mutableChainedCallable, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean;
        let { outer } = flag
          ? { outer: { worker: () => undefined } }
          : { outer: { worker: f.agent } };
        const { worker } = outer;
        worker('review', { task: 'x' });
      `);
      const mutableChainedResult = scanTypeScript(mutableChainedCallable);
      expect(mutableChainedResult.calls).toBe(1);
      expect(mutableChainedResult.missing).toHaveLength(1);

      const assignedAlternativeCallable = join(directory, 'assigned-alternative-callable.flow.ts');
      writeFileSync(assignedAlternativeCallable, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean;
        let call: any;
        ({ call } = flag ? { call: () => undefined } : { call: f.agent });
        call('review', { task: 'x' });
      `);
      const assignedAlternativeResult = scanTypeScript(assignedAlternativeCallable);
      expect(assignedAlternativeResult.calls).toBe(1);
      expect(assignedAlternativeResult.missing).toHaveLength(1);

      const forOfCallable = join(directory, 'for-of-callable.flow.ts');
      writeFileSync(forOfCallable, `
        declare const f: { agent(name: string, options: { task: string }): void };
        let call: any;
        for (call of [f.agent]) call('review', { task: 'x' });
      `);
      const forOfCallableResult = scanTypeScript(forOfCallable);
      expect(forOfCallableResult.calls).toBe(1);
      expect(forOfCallableResult.missing).toHaveLength(1);

      const forOfIterableForms = [
        `const workers = [f.agent]; let call: any; for (call of workers) call('review', { task: 'x' });`,
        `let call: any; for (call of [...[f.agent]]) call('review', { task: 'x' });`,
        `let call: any; for (call of flag ? [() => undefined] : [f.agent]) call('review', { task: 'x' });`,
        `for (const call of [f.agent]) call('review', { task: 'x' });`,
        `for (const [call] of [[f.agent]]) call('review', { task: 'x' });`,
      ];
      for (const [index, source] of forOfIterableForms.entries()) {
        const file = join(directory, `for-of-iterable-${index}.flow.ts`);
        writeFileSync(file, `
          declare const f: { agent(name: string, options: { task: string }): void };
          declare const flag: boolean;
          ${source}
        `);
        const result = scanTypeScript(file);
        expect(result.calls, source).toBe(1);
        expect(result.missing, source).toHaveLength(1);
      }

      const forInComputedCallable = join(directory, 'for-in-computed-callable.flow.ts');
      writeFileSync(forInComputedCallable, `
        declare const f: {
          agent(name: string, options: { task: string }): void;
          llm(prompt: string, options: { output: object }): void;
        };
        let key: string;
        for (key in { agent: true, llm: true }) f[key]('review', { task: 'x' });
      `);
      const forInComputedResult = scanTypeScript(forInComputedCallable);
      expect(forInComputedResult.calls).toBe(1);
      expect(forInComputedResult.missing).toHaveLength(1);

      const forInObjectCallable = join(directory, 'for-in-object-callable.flow.ts');
      writeFileSync(forInObjectCallable, `
        declare const f: { agent(name: string, options: { task: string }): void };
        const box: any = { worker: f.agent };
        let key: string;
        for (key in box) box[key]('review', { task: 'x' });
      `);
      const forInObjectResult = scanTypeScript(forInObjectCallable);
      expect(forInObjectResult.calls).toBe(1);
      expect(forInObjectResult.missing).toHaveLength(1);

      const forInDeclaredObjectCallable = join(directory, 'for-in-declared-object-callable.flow.ts');
      writeFileSync(forInDeclaredObjectCallable, `
        declare const f: { agent(name: string, options: { task: string }): void };
        const box: any = { worker: f.agent };
        for (const key in box) box[key]('review', { task: 'x' });
      `);
      const forInDeclaredObjectResult = scanTypeScript(forInDeclaredObjectCallable);
      expect(forInDeclaredObjectResult.calls).toBe(1);
      expect(forInDeclaredObjectResult.missing).toHaveLength(1);

      const alternateDestructuredWriter = join(directory, 'alternate-destructured-writer.flow.ts');
      writeFileSync(alternateDestructuredWriter, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean;
        const box: any = {};
        const source = flag ? { assign: () => undefined } : { assign: Object.assign };
        const { assign } = source;
        assign(box, { run: f.agent });
        box.run('review', { task: 'x' });
      `);
      const alternateDestructuredWriterResult = scanTypeScript(alternateDestructuredWriter);
      expect(alternateDestructuredWriterResult.calls).toBe(1);
      expect(alternateDestructuredWriterResult.missing).toHaveLength(1);

      const alternateDestructuredReflectApply = join(
        directory,
        'alternate-destructured-reflect-apply.flow.ts',
      );
      writeFileSync(alternateDestructuredReflectApply, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean;
        const box: any = {};
        const source = flag ? { apply: () => undefined } : { apply: Reflect.apply };
        const { apply } = source;
        apply(Object.assign, Object, [box, { run: f.agent }]);
        box.run('review', { task: 'x' });
      `);
      const alternateReflectApplyResult = scanTypeScript(alternateDestructuredReflectApply);
      expect(alternateReflectApplyResult.calls).toBe(1);
      expect(alternateReflectApplyResult.missing).toHaveLength(1);

      const assignedAlternativeWriter = join(directory, 'assigned-alternative-writer.flow.ts');
      writeFileSync(assignedAlternativeWriter, `
        declare const f: { agent(name: string, options: { task: string }): void };
        declare const flag: boolean;
        const box: any = {};
        let assign: any;
        ({ assign } = flag ? { assign: () => undefined } : { assign: Object.assign });
        assign(box, { run: f.agent });
        box.run('review', { task: 'x' });
      `);
      const assignedAlternativeWriterResult = scanTypeScript(assignedAlternativeWriter);
      expect(assignedAlternativeWriterResult.calls).toBe(1);
      expect(assignedAlternativeWriterResult.missing).toHaveLength(1);

      const forOfWriter = join(directory, 'for-of-writer.flow.ts');
      writeFileSync(forOfWriter, `
        declare const f: { agent(name: string, options: { task: string }): void };
        const box: any = {};
        let assign: any;
        for (assign of [Object.assign]) assign(box, { run: f.agent });
        box.run('review', { task: 'x' });
      `);
      const forOfWriterResult = scanTypeScript(forOfWriter);
      expect(forOfWriterResult.calls).toBe(1);
      expect(forOfWriterResult.missing).toHaveLength(1);

      const forOfAliasWriter = join(directory, 'for-of-alias-writer.flow.ts');
      writeFileSync(forOfAliasWriter, `
        declare const f: { agent(name: string, options: { task: string }): void };
        const box: any = {}, assigners = [Object.assign];
        for (const assign of assigners) assign(box, { run: f.agent });
        box.run('review', { task: 'x' });
      `);
      const forOfAliasWriterResult = scanTypeScript(forOfAliasWriter);
      expect(forOfAliasWriterResult.calls).toBe(1);
      expect(forOfAliasWriterResult.missing).toHaveLength(1);

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
