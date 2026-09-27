import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
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

const NAMED_AGENT_SOURCE_WAIVERS = new Map([
  [
    'examples/research/research.flow.ts',
    'Each dynamic lane resolves through the exhaustive, explicitly pinned header agents map.',
  ],
]);

const DYNAMIC_PAIR_SOURCE_WAIVERS = new Map([
  [
    'examples/babysitter/babysitter.flow.ts',
    'The selected reviewer CLI is mapped by generatedModelForCli and covered by the example regression.',
  ],
  [
    'examples/babysitter/legacy/pr-reviewer.flow.ts',
    'The operator-selected legacy reviewer maps the supported Claude and Codex CLIs inline; custom wrappers require an explicit model.',
  ],
  [
    'packages/sdk/scripts/dogfood/close-pr.flow.ts',
    'The operator-selected repair CLI is mapped inline and every supported mapping is covered by close-pr-flow.test.ts.',
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

function literal(expression: ts.Expression | undefined, constants: Map<string, string>): string | undefined {
  if (expression && ts.isStringLiteralLike(expression)) return expression.text;
  if (expression && ts.isIdentifier(expression)) return constants.get(expression.text);
  return undefined;
}

function scanTypeScript(path: string): {
  calls: number;
  missing: string[];
  pairs: string[];
  namedPairs: string[];
  unresolved: string[];
} {
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const constants = new Map<string, string>();
  const missing: string[] = [];
  const pairs: string[] = [];
  const namedPairs: string[] = [];
  const unresolved: string[] = [];
  let calls = 0;

  const collectConstants = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      constants.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collectConstants);
  };
  collectConstants(file);

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file).replaceAll(/["']/gu, '') === 'agents'
      && ts.isObjectLiteralExpression(node.initializer)) {
      for (const agent of node.initializer.properties) {
        if (!ts.isPropertyAssignment(agent) || !ts.isObjectLiteralExpression(agent.initializer)) continue;
        const cli = literal(property(agent.initializer, 'cli'), constants);
        const model = literal(property(agent.initializer, 'model'), constants);
        if (cli && model) namedPairs.push(`${cli}/${model}`);
      }
    }
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
          missing.push(`${relative(ROOT, path)}:${line} omits ${!cliExpression ? 'cli' : 'model'}`);
        } else {
          const cli = literal(cliExpression, constants);
          const model = literal(modelExpression, constants);
          if (cli && model) pairs.push(`${cli}/${model}`);
          else unresolved.push(`${relative(ROOT, path)}:${line} has a dynamic CLI/model pair`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { calls, missing, pairs, namedPairs, unresolved };
}

function expectSupported(pair: string, where: string): void {
  const slash = pair.indexOf('/');
  const cli = pair.slice(0, slash);
  const model = pair.slice(slash + 1);
  expect(MODELS[cli], `${where}: disabled or unknown CLI ${cli}`).toBeDefined();
  expect(MODELS[cli]?.has(model), `${where}: unsupported pair ${pair}`).toBe(true);
}

describe('first-party shipped v2 source model pins', () => {
  it('gives every TypeScript agent an explicit supported pair or a pinned named-agent declaration', () => {
    const paths = [
      ...filesBelow(resolve(ROOT, 'examples'), '.flow.ts'),
      ...filesBelow(resolve(ROOT, 'workflows'), '.flow.ts'),
      ...filesBelow(resolve(ROOT, 'packages/sdk/scripts/dogfood'), '.flow.ts'),
    ];
    const seenWaivers = new Set<string>();
    const seenDynamicWaivers = new Set<string>();
    for (const path of paths) {
      const name = relative(ROOT, path);
      const result = scanTypeScript(path);
      for (const pair of [...result.pairs, ...result.namedPairs]) expectSupported(pair, name);
      if (result.unresolved.length > 0) {
        const reason = DYNAMIC_PAIR_SOURCE_WAIVERS.get(name);
        expect(reason, `${result.unresolved.join('\n')}\nDynamic pairs need an explicit tested waiver.`).toBeDefined();
        seenDynamicWaivers.add(name);
      }
      if (result.missing.length === 0) continue;
      const reason = NAMED_AGENT_SOURCE_WAIVERS.get(name);
      expect(reason, `${result.missing.join('\n')}\nMissing calls need an explicit named-agent waiver.`).toBeDefined();
      expect(result.namedPairs.length, `${name}: waiver requires pinned named agents`).toBeGreaterThan(0);
      seenWaivers.add(name);
    }
    expect(seenWaivers).toEqual(new Set(NAMED_AGENT_SOURCE_WAIVERS.keys()));
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
