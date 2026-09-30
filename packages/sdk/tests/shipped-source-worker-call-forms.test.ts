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
