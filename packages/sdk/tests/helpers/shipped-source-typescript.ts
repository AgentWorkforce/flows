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

function hasUnprovableOverrides(object: ts.ObjectLiteralExpression, critical: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  for (const candidate of object.properties) {
    if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) return true;
    const name = propertyName(candidate.name);
    if (name === undefined) return true;
    if (critical.has(name) && seen.has(name)) return true;
    seen.add(name);
  }
  return false;
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

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expression.expression;
  }
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
  if (ts.isCallExpression(expression) && memberName(expression.expression) === 'bind') {
    const receiver = memberReceiver(expression.expression);
    return receiver ? workerMethodName(receiver, checker, seen) : undefined;
  }
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

function workerInvocation(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): { method: string; args: readonly ts.Expression[] } | undefined {
  const direct = workerMethodName(node.expression, checker);
  if (direct === 'agent' || direct === 'llm') return { method: direct, args: node.arguments };

  const operation = memberName(node.expression);
  const receiver = memberReceiver(node.expression);
  const method = receiver ? workerMethodName(receiver, checker) : undefined;
  if (method !== 'agent' && method !== 'llm') return undefined;
  if (operation === 'call') return { method, args: node.arguments.slice(1) };
  if (operation === 'apply') {
    const applied = node.arguments[1];
    return {
      method,
      // A dynamic argument list is a real worker invocation, but its pair is
      // not statically auditable. Empty args make the caller fail closed.
      args: applied && ts.isArrayLiteralExpression(applied) ? applied.elements : [],
    };
  }
  return undefined;
}

function isFlowConstructor(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrapTransparentExpression(expression);
  if (memberName(expression) === 'flow') {
    const receiver = memberReceiver(expression);
    const namespace = receiver && ts.isIdentifier(unwrapTransparentExpression(receiver))
      ? checker.getSymbolAtLocation(unwrapTransparentExpression(receiver))
      : undefined;
    if (namespace?.declarations?.some(ts.isNamespaceImport)) return true;
  }
  if (ts.isCallExpression(expression) && memberName(expression.expression) === 'bind') {
    const receiver = memberReceiver(expression.expression);
    return receiver ? isFlowConstructor(receiver, checker, seen) : false;
  }
  if (!ts.isIdentifier(expression)) return false;
  if (expression.text === 'flow') return true;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const imported = symbol.declarations?.find(ts.isImportSpecifier);
  if (imported && (imported.propertyName ?? imported.name).text === 'flow') return true;
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding && ts.isObjectBindingPattern(binding.parent)) {
    const name = binding.propertyName ?? binding.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'flow') return true;
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  return Boolean(variable?.initializer && ts.isVariableDeclarationList(variable.parent)
    && (variable.parent.flags & ts.NodeFlags.Const) !== 0
    && isFlowConstructor(variable.initializer, checker, seen));
}

function flowInvocation(
  node: ts.Node,
  checker: ts.TypeChecker,
): { args: readonly ts.Expression[]; auditable: boolean } | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (isFlowConstructor(node.expression, checker)) return { args: node.arguments, auditable: true };
  const operation = memberName(node.expression);
  const receiver = memberReceiver(node.expression);
  if (!receiver || !isFlowConstructor(receiver, checker)) return undefined;
  if (operation === 'call') return { args: node.arguments.slice(1), auditable: true };
  if (operation !== 'apply') return undefined;
  const applied = node.arguments[1];
  return applied && ts.isArrayLiteralExpression(applied)
    ? { args: applied.elements, auditable: true }
    : { args: [], auditable: false };
}

function flowHeader(args: readonly ts.Expression[], checker: ts.TypeChecker): ts.Expression | undefined {
  if (args.length < 2) return undefined;
  const candidate = args[1];
  if (candidate === undefined) return undefined;
  if (args.length === 2 && checker.getTypeAtLocation(candidate).getCallSignatures().length > 0) {
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
    const invocation = flowInvocation(node, checker);
    if (invocation && ts.isCallExpression(node)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (!invocation.auditable) {
        invalidFlowHeaders.push(`${relative(ROOT, path)}:${line} flow arguments must be statically auditable`);
        ts.forEachChild(node, collectFlowHeaders);
        return;
      }
      const header = flowHeader(invocation.args, checker);
      if (header === undefined) {
        ts.forEachChild(node, collectFlowHeaders);
        return;
      }
      if (!ts.isObjectLiteralExpression(header)
        || hasUnprovableOverrides(header, new Set(['budget', 'agents']))) {
        invalidFlowHeaders.push(`${relative(ROOT, path)}:${line} flow header must be inline and statically auditable`);
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
        const agentNames = new Set<string>();
        for (const agent of agentsExpression.properties) {
          const agentLine = file.getLineAndCharacterOfPosition(agent.getStart(file)).line + 1;
          const name = propertyName(agent.name);
          if (!ts.isPropertyAssignment(agent) || !ts.isObjectLiteralExpression(agent.initializer)
            || name === undefined || agentNames.has(name)
            || hasUnprovableOverrides(agent.initializer, new Set(['cli', 'model']))) {
            incompleteNamed.push(`${relative(ROOT, path)}:${agentLine}`);
            continue;
          }
          agentNames.add(name);
          const cli = literal(property(agent.initializer, 'cli'), checker);
          const model = literal(property(agent.initializer, 'model'), checker);
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
      if (ts.isCallExpression(parent) && flowInvocation(parent, checker)) return parent;
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
      const invocation = workerInvocation(node, checker);
      if (invocation === undefined) {
        ts.forEachChild(node, visitCalls);
        return;
      }
      const { method, args } = invocation;
      calls += 1;
      const options = args[1];
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (!options || !ts.isObjectLiteralExpression(options)) {
        missing.push(`${relative(ROOT, path)}:${line} has no inline options object`);
      } else if (hasUnprovableOverrides(options, new Set(['cli', 'model']))) {
        missing.push(`${relative(ROOT, path)}:${line} has unprovable options overrides`);
      } else {
        const cliExpression = property(options, 'cli');
        const modelExpression = property(options, 'model');
        if (!cliExpression || !modelExpression) {
          const names = stringValues(args[0], checker);
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
              call: args[0]?.getText(file) ?? '<missing-name>',
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
