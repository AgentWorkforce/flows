import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

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

function filesBelow(path: string, suffix: string): string[] {
  return readdirSync(path).flatMap(entry => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const file = resolve(path, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? filesBelow(file, suffix) : file.endsWith(suffix) ? [file] : [];
  });
}

function launchedDeclarativeSources(): ReadonlySet<string> {
  const operationalFiles = ['.github', 'ops', 'scripts'].flatMap(directory =>
    ['.yml', '.yaml', '.sh'].flatMap(suffix => filesBelow(resolve(ROOT, directory), suffix)));
  const launched = new Set<string>();
  const command = /\b(?:agent-relay\s+cloud\s+run|flows\s+run)[\s\\]+(?:\.\.\/gate-files\/)?(workflows\/[A-Za-z0-9._/-]+\.ya?ml)/gu;
  for (const path of operationalFiles) {
    for (const match of readFileSync(path, 'utf8').matchAll(command)) {
      const source = match[1];
      if (source !== undefined && existsSync(resolve(ROOT, source))) launched.add(source);
    }
  }
  return launched;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const candidate = object.properties.find(property => property.name?.getText().replaceAll(/["']/gu, '') === name);
  if (candidate && ts.isPropertyAssignment(candidate)) return candidate.initializer;
  if (candidate && ts.isShorthandPropertyAssignment(candidate)) return candidate.name;
  return undefined;
}

function identifierSymbol(expression: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(expression.parent)
    ? checker.getShorthandAssignmentValueSymbol(expression.parent)
    : checker.getSymbolAtLocation(expression);
}

function constInitializer(expression: ts.Expression | undefined, checker: ts.TypeChecker): ts.Expression | undefined {
  if (!expression || !ts.isIdentifier(expression)) return expression;
  const symbol = identifierSymbol(expression, checker);
  const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
  if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return expression;
  return declaration.initializer;
}

function literal(expression: ts.Expression | undefined, checker: ts.TypeChecker): string | undefined {
  const resolved = constInitializer(expression, checker);
  return resolved && ts.isStringLiteralLike(resolved) ? resolved.text : undefined;
}

function numericLiteral(expression: ts.Expression | undefined, checker: ts.TypeChecker): number | undefined {
  const resolved = constInitializer(expression, checker);
  if (!resolved || !ts.isNumericLiteral(resolved)) return undefined;
  const value = Number(resolved.text.replaceAll('_', ''));
  return Number.isFinite(value) ? value : undefined;
}

function objectLiteral(expression: ts.Expression | undefined, checker: ts.TypeChecker): ts.ObjectLiteralExpression | undefined {
  const resolved = constInitializer(expression, checker);
  if (!resolved || !ts.isObjectLiteralExpression(resolved)) return undefined;
  if (resolved.properties.some(ts.isSpreadAssignment)) return undefined;
  const ceilingFields = resolved.properties
    .map(candidate => candidate.name?.getText().replaceAll(/["']/gu, ''))
    .filter(name => name === 'tokens' || name === 'dollars');
  if (new Set(ceilingFields).size !== ceilingFields.length) return undefined;
  if (!expression || !ts.isIdentifier(expression)) return resolved;

  const symbol = identifierSymbol(expression, checker);
  const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
  if (!symbol || !declaration || !ts.isIdentifier(declaration.name)) return undefined;
  let onlyBudgetReferences = true;
  const visit = (node: ts.Node): void => {
    if (!onlyBudgetReferences) return;
    if (ts.isIdentifier(node) && identifierSymbol(node, checker) === symbol) {
      const isDeclaration = node === declaration.name;
      // The one accepted reference is the exact `budget` property currently
      // being inspected. A second `{ budget }` container is an alias through
      // which the object can be mutated without touching the original symbol.
      if (!isDeclaration && node !== expression) onlyBudgetReferences = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return onlyBudgetReferences ? resolved : undefined;
}

function memberName(expression: ts.Expression): string | undefined {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return undefined;
}

function workerMethodName(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const direct = memberName(expression);
  if (direct !== undefined) return direct;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isIdentifier(expression)) return undefined;
  const declaration = checker.getSymbolAtLocation(expression)?.declarations?.find(ts.isBindingElement);
  if (!declaration || !ts.isObjectBindingPattern(declaration.parent)) return undefined;
  const propertyName = declaration.propertyName ?? declaration.name;
  return ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName) ? propertyName.text : undefined;
}

function isFlowCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  let expression: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) && expression.text === 'flow';
}

function flowHeader(node: ts.CallExpression, checker: ts.TypeChecker): ts.Expression | undefined {
  if (node.arguments.length < 2) return undefined;
  const candidate = node.arguments[1];
  if (candidate === undefined) return undefined;
  if (node.arguments.length === 2 && checker.getTypeAtLocation(candidate).getCallSignatures().length > 0) {
    return undefined;
  }
  return candidate;
}

function isRequiredString(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(expression);
  return (type.flags & ts.TypeFlags.StringLike) !== 0
    && (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0;
}

function stringValues(expression: ts.Expression | undefined, checker: ts.TypeChecker): string[] | undefined {
  if (expression === undefined) return undefined;
  const direct = literal(expression, checker);
  if (direct !== undefined) return [direct];
  const type = checker.getTypeAtLocation(expression);
  const members = type.isUnion() ? type.types : [type];
  const values = members.flatMap(member => member.isStringLiteral() ? [member.value] : []);
  return values.length === members.length && values.length > 0 ? values : undefined;
}

function scanTypeScript(path: string): {
  calls: number;
  missing: string[];
  pairs: string[];
  namedPairs: string[];
  incompleteNamed: string[];
  invalidFlowHeaders: string[];
  unresolved: Array<{ call: string; where: string }>;
  dollarBudgetsWithoutTokenCeilings: string[];
} {
  const program = ts.createProgram([path], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  });
  const file = program.getSourceFile(path);
  if (file === undefined) throw new Error(`TypeScript did not load ${path}`);
  const checker = program.getTypeChecker();
  const missing: string[] = [];
  const pairs: string[] = [];
  const namedPairs: string[] = [];
  const namedAgentsByFlow = new Map<ts.CallExpression, Set<string>>();
  const incompleteNamed: string[] = [];
  const invalidFlowHeaders: string[] = [];
  const unresolved: Array<{ call: string; where: string }> = [];
  const dollarBudgetsWithoutTokenCeilings: string[] = [];
  let calls = 0;

  const collectFlowHeaders = (node: ts.Node): void => {
    if (isFlowCall(node)) {
      const header = flowHeader(node, checker);
      if (header === undefined) {
        ts.forEachChild(node, collectFlowHeaders);
        return;
      }
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (!ts.isObjectLiteralExpression(header) || header.properties.some(ts.isSpreadAssignment)) {
        invalidFlowHeaders.push(`${relative(ROOT, path)}:${line} flow header must be an inline object literal`);
        ts.forEachChild(node, collectFlowHeaders);
        return;
      }

      const budgetExpression = property(header, 'budget');
      if (budgetExpression !== undefined) {
        const budgetProperty = header.properties.find(candidate =>
          candidate.name?.getText(file).replaceAll(/["']/gu, '') === 'budget');
        const budgetLine = budgetProperty
          ? file.getLineAndCharacterOfPosition(budgetProperty.getStart(file)).line + 1
          : line;
        const budget = constInitializer(budgetExpression, checker);
        const budgetObject = objectLiteral(budgetExpression, checker);
        const isDollarString = budget !== undefined && ts.isStringLiteralLike(budget) && /^\$/u.test(budget.text);
        const dollars = budgetObject ? numericLiteral(property(budgetObject, 'dollars'), checker) : undefined;
        const tokens = budgetObject ? numericLiteral(property(budgetObject, 'tokens'), checker) : undefined;
        const isDollarObject = budget !== undefined && ts.isObjectLiteralExpression(budget)
          && property(budget, 'dollars') !== undefined;
        const hasEnforceableCeiling = dollars !== undefined && dollars > 0
          && tokens !== undefined && tokens >= 0 && tokens <= dollars * 100_000;
        if ((isDollarString || isDollarObject) && !hasEnforceableCeiling) {
          dollarBudgetsWithoutTokenCeilings.push(`${relative(ROOT, path)}:${budgetLine}`);
        }
      }

      const agentsExpression = property(header, 'agents');
      const namedAgents = new Set<string>();
      namedAgentsByFlow.set(node, namedAgents);
      if (agentsExpression !== undefined && !ts.isObjectLiteralExpression(agentsExpression)) {
        incompleteNamed.push(`${relative(ROOT, path)}:${line}`);
      } else if (agentsExpression && ts.isObjectLiteralExpression(agentsExpression)) {
        for (const agent of agentsExpression.properties) {
          const line = file.getLineAndCharacterOfPosition(agent.getStart(file)).line + 1;
          if (!ts.isPropertyAssignment(agent) || !ts.isObjectLiteralExpression(agent.initializer)) {
            incompleteNamed.push(`${relative(ROOT, path)}:${line}`);
            continue;
          }
          const cli = literal(property(agent.initializer, 'cli'), checker);
          const model = literal(property(agent.initializer, 'model'), checker);
          const name = agent.name.getText(file).replaceAll(/["']/gu, '');
          if (cli && model) {
            namedPairs.push(`${cli}/${model}`);
            namedAgents.add(name);
          }
          else incompleteNamed.push(`${relative(ROOT, path)}:${line}`);
        }
      }
    }
    ts.forEachChild(node, collectFlowHeaders);
  };
  collectFlowHeaders(file);

  const enclosingFlow = (node: ts.Node): ts.CallExpression | undefined => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (isFlowCall(parent)) return parent;
    }
    return undefined;
  };

  const visitCalls = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && workerMethodName(node.tag, checker) === 'llm') {
      calls += 1;
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      missing.push(`${relative(ROOT, path)}:${line} tagged f.llm has no explicit CLI/model options`);
    }
    if (ts.isCallExpression(node)) {
      const method = workerMethodName(node.expression, checker);
      if (method !== 'agent' && method !== 'llm') {
        ts.forEachChild(node, visitCalls);
        return;
      }
      const kind = method;
      calls += 1;
      const options = node.arguments[1];
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (!options || !ts.isObjectLiteralExpression(options)) {
        missing.push(`${relative(ROOT, path)}:${line} has no inline options object`);
      } else {
        const cliExpression = property(options, 'cli');
        const modelExpression = property(options, 'model');
        if (!cliExpression || !modelExpression) {
          const names = stringValues(node.arguments[0], checker);
          const flow = enclosingFlow(node);
          const namedAgents = flow ? namedAgentsByFlow.get(flow) : undefined;
          if (kind === 'agent' && !cliExpression && !modelExpression
            && names?.every(name => namedAgents?.has(name) === true)) {
            // This exact call resolves only through complete, literal named-agent declarations.
          } else {
            missing.push(`${relative(ROOT, path)}:${line} omits ${!cliExpression ? 'cli' : 'model'}`);
          }
        } else {
          const cli = literal(cliExpression, checker);
          const model = literal(modelExpression, checker);
          if (cli && model) pairs.push(`${cli}/${model}`);
          else if (isRequiredString(cliExpression, checker) && isRequiredString(modelExpression, checker)) {
            unresolved.push({
              call: node.arguments[0]?.getText(file) ?? '<missing-name>',
              where: `${relative(ROOT, path)}:${line}`,
            });
          } else {
            missing.push(`${relative(ROOT, path)}:${line} has a CLI/model expression that can be undefined`);
          }
        }
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(file);
  return {
    calls,
    missing,
    pairs,
    namedPairs,
    incompleteNamed,
    invalidFlowHeaders,
    unresolved,
    dollarBudgetsWithoutTokenCeilings,
  };
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
      if (result.calls > 0) {
        expect(
          result.dollarBudgetsWithoutTokenCeilings,
          `${name}: current model aliases have no verified frozen price; dollar budgets need at most 100,000 tokens per dollar`,
        ).toEqual([]);
      }
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
    const activeV1Sources = launchedDeclarativeSources();
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
    expect(activeV1Files).toBe(2);
    expect(activeV1ModelSteps).toBe(5);
  });
});
