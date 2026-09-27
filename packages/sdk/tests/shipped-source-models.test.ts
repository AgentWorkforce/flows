import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const candidate = object.properties.find(property => property.name?.getText().replaceAll(/["']/gu, '') === name);
  if (candidate && ts.isPropertyAssignment(candidate)) return candidate.initializer;
  if (candidate && ts.isShorthandPropertyAssignment(candidate)) return candidate.name;
  return undefined;
}

function literal(expression: ts.Expression | undefined, checker: ts.TypeChecker): string | undefined {
  if (expression && ts.isStringLiteralLike(expression)) return expression.text;
  if (expression && ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.declarations?.find(ts.isVariableDeclaration);
    if (declaration?.initializer && ts.isStringLiteralLike(declaration.initializer)
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) return declaration.initializer.text;
  }
  return undefined;
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
  unresolved: Array<{ call: string; where: string }>;
  dollarBudgetsWithoutTokens: string[];
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
  const namedAgents = new Set<string>();
  const incompleteNamed: string[] = [];
  const unresolved: Array<{ call: string; where: string }> = [];
  const dollarBudgetsWithoutTokens: string[] = [];
  let calls = 0;

  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file).replaceAll(/["']/gu, '') === 'budget') {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const budget = node.initializer;
      const isDollarString = ts.isStringLiteralLike(budget) && /^\$/u.test(budget.text);
      const isDollarObject = ts.isObjectLiteralExpression(budget) && property(budget, 'dollars') !== undefined;
      const hasTokens = ts.isObjectLiteralExpression(budget) && property(budget, 'tokens') !== undefined;
      if ((isDollarString || isDollarObject) && !hasTokens) {
        dollarBudgetsWithoutTokens.push(`${relative(ROOT, path)}:${line}`);
      }
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(file).replaceAll(/["']/gu, '') === 'agents'
      && ts.isObjectLiteralExpression(node.initializer)) {
      for (const agent of node.initializer.properties) {
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
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(file);

  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'agent') {
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
          if (!cliExpression && !modelExpression && names?.every(name => namedAgents.has(name))) {
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
  return { calls, missing, pairs, namedPairs, incompleteNamed, unresolved, dollarBudgetsWithoutTokens };
}

function expectSupported(pair: string, where: string): void {
  const slash = pair.indexOf('/');
  const cli = pair.slice(0, slash);
  const model = pair.slice(slash + 1);
  expect(MODELS[cli], `${where}: disabled or unknown CLI ${cli}`).toBeDefined();
  expect(MODELS[cli]?.has(model), `${where}: unsupported pair ${pair}`).toBe(true);
}

describe('first-party shipped v2 source model pins', () => {
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
        declare const f: { agent(name: string, options: { task: string }): void };
        const header = { agents: { reviewer: { cli: 'claude' } } };
        void header;
        f.agent('reviewer', { task: 'review' });
      `);
      const incompleteResult = scanTypeScript(incomplete);
      expect(incompleteResult.incompleteNamed).toHaveLength(1);
      expect(incompleteResult.missing).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives every TypeScript agent an explicit supported pair or a pinned named-agent declaration', () => {
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
      if (result.calls > 0) {
        expect(
          result.dollarBudgetsWithoutTokens,
          `${name}: current model aliases have no verified frozen price; dollar budgets need an enforceable token ceiling`,
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

  it('gives every current declarative agent an effective supported CLI/model pair', () => {
    const paths = [
      ...filesBelow(resolve(ROOT, 'examples'), '.yaml'),
      ...filesBelow(resolve(ROOT, 'workflows'), '.yaml'),
    ];
    let currentFiles = 0;
    let agentSteps = 0;
    for (const path of paths) {
      const document = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (String(document.version) !== '0.1.0') continue;
      currentFiles += 1;
      const flowCli = typeof document.cli === 'string' ? document.cli : undefined;
      const steps = Array.isArray(document.steps) ? document.steps as Array<Record<string, unknown>> : [];
      for (const step of steps.filter(candidate => candidate.type === 'agent')) {
        agentSteps += 1;
        const cli = typeof step.cli === 'string' ? step.cli : flowCli;
        const model = typeof step.model === 'string' ? step.model : undefined;
        expect(cli, `${relative(ROOT, path)}:${String(step.id)} has no effective CLI`).toBeTruthy();
        expect(model, `${relative(ROOT, path)}:${String(step.id)} has no explicit model`).toBeTruthy();
        if (cli && model) expectSupported(`${cli}/${model}`, `${relative(ROOT, path)}:${String(step.id)}`);
      }
    }
    expect(currentFiles).toBe(7);
    expect(agentSteps).toBe(8);
  });
});
