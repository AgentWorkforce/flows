import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

const ROOT = resolve('../..');
const MODELS: Record<string, ReadonlySet<string>> = {
  claude: new Set(['claude-sonnet-5', 'claude-opus-5']),
  codex: new Set(['gpt-5.6-sol']),
  'cursor-agent': new Set(['gpt-5.6-sol-high']),
  grok: new Set(['grok-4.7']),
};
const DYNAMIC_PAIR_SOURCE_WAIVERS = new Map([
  [
    'examples/babysitter/babysitter.flow.ts',
    ['`babysitter-${lens}`'],
  ],
  [
    'examples/babysitter/legacy/pr-reviewer.flow.ts',
    ['"review"'],
  ],
  [
    'packages/sdk/scripts/dogfood/close-pr.flow.ts',
    ['repairCli'],
  ],
]);

// RelayCron stores these registrations outside the repository, so there is no
// executable launch command for source discovery to find. Keep this manifest in
// lockstep with the schedules documented in ops/AUTONOMY.md.
const REGISTERED_SCHEDULE_SOURCES = new Set([
  'workflows/drive.yaml',
  'workflows/watchdog.yaml',
]);

function filesBelow(path: string, suffix: string): string[] {
  return readdirSync(path).flatMap(entry => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const file = resolve(path, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? filesBelow(file, suffix) : file.endsWith(suffix) ? [file] : [];
  });
}

function activeDeclarativeSources(): ReadonlySet<string> {
  const operationalFiles = ['.github', 'ops', 'scripts'].flatMap(directory =>
    ['.yml', '.yaml', '.sh'].flatMap(suffix => filesBelow(resolve(ROOT, directory), suffix)));
  const active = new Set(REGISTERED_SCHEDULE_SOURCES);
  const command = /\b(?:agent-relay\s+cloud\s+run|flows\s+run)[\s\\]+(?:\.\.\/gate-files\/)?(workflows\/[A-Za-z0-9._/-]+\.ya?ml)/gu;
  for (const path of operationalFiles) {
    for (const match of readFileSync(path, 'utf8').matchAll(command)) {
      const source = match[1];
      if (source !== undefined && existsSync(resolve(ROOT, source))) active.add(source);
    }
  }
  for (const source of active) expect(existsSync(resolve(ROOT, source)), `${source}: active workflow source must exist`).toBe(true);
  return active;
}

function scanDeclarative(document: Record<string, unknown>, where: string): {
  calls: number;
  missing: string[];
  pairs: string[];
} {
  const flowCli = typeof document.cli === 'string' ? document.cli : undefined;
  const agents = new Map<string, { cli?: string; model?: string }>();
  if (Array.isArray(document.agents)) {
    for (const candidate of document.agents as Array<Record<string, unknown>>) {
      if (typeof candidate.name === 'string') {
        agents.set(candidate.name, {
          cli: typeof candidate.cli === 'string' ? candidate.cli : undefined,
          model: typeof candidate.model === 'string' ? candidate.model : undefined,
        });
      }
    }
  } else if (document.agents && typeof document.agents === 'object') {
    for (const [name, value] of Object.entries(document.agents as Record<string, unknown>)) {
      const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      agents.set(name, {
        cli: typeof candidate.cli === 'string' ? candidate.cli : undefined,
        model: typeof candidate.model === 'string' ? candidate.model : undefined,
      });
    }
  }
  const workflows = Array.isArray(document.workflows) ? document.workflows as Array<Record<string, unknown>> : [];
  const steps = Array.isArray(document.steps)
    ? document.steps as Array<Record<string, unknown>>
    : workflows.flatMap(workflow => Array.isArray(workflow.steps) ? workflow.steps as Array<Record<string, unknown>> : []);
  const modelSteps = steps.filter(candidate => candidate.type === 'agent' || candidate.type === 'llm');
  const missing: string[] = [];
  const pairs: string[] = [];
  for (const [name, agent] of agents) {
    if (!agent.cli) missing.push(`${where}:agent:${name} has no effective CLI`);
    if (!agent.model) missing.push(`${where}:agent:${name} has no explicit model`);
    if (agent.cli && agent.model) pairs.push(`${agent.cli}/${agent.model}`);
  }
  for (const step of modelSteps) {
    const label = `${where}:${String(step.id ?? step.name)}`;
    const named = typeof step.agent === 'string' ? agents.get(step.agent) : undefined;
    const cli = typeof step.cli === 'string' ? step.cli : named?.cli ?? flowCli;
    const model = typeof step.model === 'string' ? step.model : named?.model;
    if (!cli) missing.push(`${label} has no effective CLI`);
    if (!model) missing.push(`${label} has no explicit model`);
    if (cli && model) pairs.push(`${cli}/${model}`);
  }
  return { calls: modelSteps.length, missing, pairs };
}

function expectSupported(pair: string, where: string): void {
  const slash = pair.indexOf('/');
  const cli = pair.slice(0, slash);
  const model = pair.slice(slash + 1);
  expect(MODELS[cli], `${where}: disabled or unknown CLI ${cli}`).toBeDefined();
  expect(MODELS[cli]?.has(model), `${where}: unsupported pair ${pair}`).toBe(true);
}

describe('first-party shipped source model pins', () => {
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
        declare function flow(name: string, header: unknown, body: () => void): void;
        const budget = { tokens: 200_000, dollars: 2 };
        const header = { budget };
        header.budget.tokens = 20_000_000;
        flow('mutated-through-header', header, () => {});
      `);
      expect(scanTypeScript(aliasedHeader).invalidFlowHeaders).toHaveLength(1);

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
        const define = flow, bound = flow.bind(undefined), helper = flow.call, applyHelper = flow.apply, helperBound = helper.bind(flow, undefined), api = surface; const { flow: destructured, ['flow']: computed } = surface;
        const preboundName = flow.bind(undefined, 'prebound-name'), preboundHeader = flow.bind(undefined, 'prebound-header', { budget: '$2' });
        define('aliased', { budget: '$2' }, () => {}); bound('bound', { budget: '$2' }, () => {}); destructured('destructured', { budget: '$2' }, () => {});
        preboundName({ budget: '$2' }, () => {}); preboundHeader(() => {}); helper(undefined, 'helper', { budget: '$2' }, () => {}); applyHelper(undefined, ['apply-helper', { budget: '$2' }, () => {}]); helperBound('helper-bound', { budget: '$2' }, () => {});
        importedFlow('imported', { budget: '$2' }, () => {}); api.flow('namespace-alias', { budget: '$2' }, () => {}); computed('computed-binding', { budget: '$2' }, () => {});
        surface.flow('namespace', { budget: '$2' }, () => {}); surface.flow.call(undefined, 'called', { budget: '$2' }, () => {}); surface.flow.apply(undefined, ['applied', { budget: '$2' }, () => {}]); surface.flow.apply(undefined, [] as unknown as []);
        surface.flow.call(undefined, ...flowArgs); surface.flow.apply(undefined, [...flowArgs]); flow.bind(...bindArgs)({ budget: '$2' }, () => {}); flow.call(...callArgs); flow.apply(...receiverArgs, ['outer-applied', { budget: '$2' }, () => {}]);
        flow('accessor', { get budget() { return { dollars: 2, tokens: 20_000_000 }; } }, () => {});
        flow('duplicate', { budget: '$2', budget: '$1' }, () => {});
      `);
      const unsafeFlowHeaderResult = scanTypeScript(unsafeFlowHeaders);
      expect(unsafeFlowHeaderResult.dollarBudgetsWithoutTokenCeilings).toHaveLength(14);
      expect(unsafeFlowHeaderResult.invalidFlowHeaders).toHaveLength(8);

      const namedBody = join(directory, 'named-body.flow.ts');
      writeFileSync(namedBody, `
        declare function flow(name: string, body: () => void): void;
        const body = () => {};
        flow('body', body);
      `);
      expect(scanTypeScript(namedBody).invalidFlowHeaders).toEqual([]);

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
        const generate = (f['llm']);
        runAgent('review', { task: 'x' });
        generate('prompt', { output: {} });
      `);
      const variableAliasResult = scanTypeScript(variableAliases);
      expect(variableAliasResult.calls).toBe(2);
      expect(variableAliasResult.missing).toHaveLength(2);

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
        const runAgent = f.agent.bind(f), preboundAgent = f.agent.bind(f, 'real', { task: 'x' });
        const generate = f['llm']['bind'](f), preboundLlm = f.llm.bind(f, 'real', { output: {} });
        runAgent('review', { task: 'x' }); preboundAgent('ignored', { cli: 'claude', model: 'claude-sonnet-5' });
        generate('prompt', { output: {} }); preboundLlm('ignored', { cli: 'claude', model: 'claude-sonnet-5' });
      `);
      const boundAliasResult = scanTypeScript(boundAliases);
      expect(boundAliasResult.calls).toBe(4);
      expect(boundAliasResult.missing).toHaveLength(4);

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

  it('gives every TypeScript agent and LLM an explicit supported pair or a pinned named-agent declaration', () => {
    const paths = [
      ...filesBelow(resolve(ROOT, 'examples'), '.flow.ts'),
      resolve(ROOT, 'examples/babysitter/hosted.ts'),
      ...filesBelow(resolve(ROOT, 'workflows'), '.flow.ts'),
      ...filesBelow(resolve(ROOT, 'packages/sdk/scripts/dogfood'), '.flow.ts'),
    ];
    const seenDynamicWaivers = new Set<string>();
    for (const path of paths) {
      const name = relative(ROOT, path);
      const result = scanTypeScript(path);
      for (const pair of [...result.pairs, ...result.namedPairs]) expectSupported(pair, name);
      expect(result.incompleteNamed, `${name}: every named agent must declare a literal cli and model`).toEqual([]);
      expect(result.invalidFlowHeaders, `${name}: flow headers must be inline and statically auditable`).toEqual([]);
      expect(
        result.dollarBudgetsWithoutTokenCeilings,
        `${name}: current model aliases have no verified frozen price; dollar budgets need at most 100,000 tokens per dollar`,
      ).toEqual([]);
      if (result.unresolved.length > 0) {
        const expectedCalls = DYNAMIC_PAIR_SOURCE_WAIVERS.get(name);
        expect(expectedCalls, `${result.unresolved.map(item => item.where).join('\n')}\nDynamic pairs need an exact tested waiver.`).toBeDefined();
        expect(result.unresolved.map(item => item.call), `${name}: dynamic waivers are call-exact and count-exact`).toEqual(expectedCalls);
        seenDynamicWaivers.add(name);
      }
      expect(result.missing, `${name}: omitted pairs must resolve call-exactly through complete named agents`).toEqual([]);
    }
    expect(seenDynamicWaivers).toEqual(new Set(DYNAMIC_PAIR_SOURCE_WAIVERS.keys()));
  });

  it('gives every current declarative and active v1 Cloud agent/LLM an effective supported CLI/model pair', () => {
    const paths = [
      ...filesBelow(resolve(ROOT, 'examples'), '.yaml'),
      ...filesBelow(resolve(ROOT, 'workflows'), '.yaml'),
    ];
    let currentFiles = 0;
    let modelSteps = 0;
    let activeV1Files = 0;
    let activeV1ModelSteps = 0;
    const activeV1Sources = activeDeclarativeSources();
    for (const path of paths) {
      const document = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const name = relative(ROOT, path);
      const isCurrent = String(document.version) === '0.1.0';
      const isActiveV1 = activeV1Sources.has(name) && !isCurrent;
      if (!isCurrent && !isActiveV1) continue;
      if (isCurrent) currentFiles += 1;
      if (isActiveV1) activeV1Files += 1;
      const result = scanDeclarative(document, name);
      if (isCurrent) modelSteps += result.calls;
      if (isActiveV1) activeV1ModelSteps += result.calls;
      expect(result.missing, `${name}: every declarative agent/LLM needs an effective CLI and explicit model`).toEqual([]);
      for (const pair of result.pairs) expectSupported(pair, name);
    }
    expect(currentFiles).toBe(7);
    expect(modelSteps).toBe(8);
    expect(activeV1Files).toBe(4);
    expect(activeV1ModelSteps).toBe(10);
  });
});
