import { relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve('../..');

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const candidate = object.properties.find(property => propertyName(property.name) === name);
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
  if (resolved.properties.some(candidate =>
    (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate))
    || propertyName(candidate.name) === undefined)) return undefined;
  const ceilingFields = resolved.properties
    .map(candidate => propertyName(candidate.name))
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
      // being inspected. Any other reference can mutate or alias the object.
      if (!isDeclaration && node !== expression) onlyBudgetReferences = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return onlyBudgetReferences ? resolved : undefined;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function memberName(expression: ts.Expression): string | undefined {
  expression = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return undefined;
}

function workerMethodName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  const direct = memberName(expression);
  if (direct !== undefined) return direct;
  expression = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding && ts.isObjectBindingPattern(binding.parent)) {
    const propertyName = binding.propertyName ?? binding.name;
    return ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName) ? propertyName.text : undefined;
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)
    || (variable.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  return workerMethodName(variable.initializer, checker, seen);
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

export interface TypeScriptModelInventory {
  calls: number;
  missing: string[];
  pairs: string[];
  namedPairs: string[];
  incompleteNamed: string[];
  invalidFlowHeaders: string[];
  unresolved: Array<{ call: string; where: string }>;
  dollarBudgetsWithoutTokenCeilings: string[];
}

export function scanTypeScript(path: string): TypeScriptModelInventory {
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
        const isBudgetString = budget !== undefined && ts.isStringLiteralLike(budget);
        const isDollarString = isBudgetString && /^\$/u.test(budget.text);
        const dollars = budgetObject ? numericLiteral(property(budgetObject, 'dollars'), checker) : undefined;
        const tokens = budgetObject ? numericLiteral(property(budgetObject, 'tokens'), checker) : undefined;
        const isDollarObject = budgetObject !== undefined && property(budgetObject, 'dollars') !== undefined;
        const isUnclassifiable = !isBudgetString && budgetObject === undefined;
        const hasEnforceableCeiling = dollars !== undefined && dollars > 0
          && tokens !== undefined && tokens >= 0 && tokens <= dollars * 100_000;
        if (isUnclassifiable || ((isDollarString || isDollarObject) && !hasEnforceableCeiling)) {
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
          const agentLine = file.getLineAndCharacterOfPosition(agent.getStart(file)).line + 1;
          if (!ts.isPropertyAssignment(agent) || !ts.isObjectLiteralExpression(agent.initializer)) {
            incompleteNamed.push(`${relative(ROOT, path)}:${agentLine}`);
            continue;
          }
          const cli = literal(property(agent.initializer, 'cli'), checker);
          const model = literal(property(agent.initializer, 'model'), checker);
          const name = agent.name.getText(file).replaceAll(/["']/gu, '');
          if (cli && model) {
            namedPairs.push(`${cli}/${model}`);
            namedAgents.add(name);
          } else incompleteNamed.push(`${relative(ROOT, path)}:${agentLine}`);
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
          if (method === 'agent' && !cliExpression && !modelExpression
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
