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

describe('shipped-source flow header provenance', () => {
  it('fails closed for unsafe authored and declarative headers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-flow-header-invariant-'));
    try {
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
              - name: assess-untyped-v1
                agent: lead
                task: inspect
      `) as Record<string, unknown>, 'drive-cloud.yaml');
      expect(activeV1.calls).toBe(2);
      expect(activeV1.missing).toEqual([
        'drive-cloud.yaml:agent:lead has no explicit model',
        'drive-cloud.yaml:assess has no explicit model',
        'drive-cloud.yaml:assess-untyped-v1 has no explicit model',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
